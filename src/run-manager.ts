import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AdapterRegistry } from "./adapters/index.js";
import { ChannelMonitor } from "./channel-monitor.js";
import { bindInboxEvents } from "./inbox-state.js";
import { HerdrLaunchCleanupError } from "./adapters/herdr.js";
import {
	createChannel,
	readActiveTurn,
	listTalkToMain,
	readSubClosed,
	readSubSessionInfo,
	readManifest,
	removeChannel,
	talkToSub,
	writeClose,
	writeSubClosed,
	writeInterrupt,
} from "./channel.js";
import type { ResolvedProfile } from "./profiles/types.js";
import { listResumableSubSessions, resolveResumableSubSession } from "./sessions.js";
import { MANUAL_MAIN_GUIDANCE } from "./manual-context.js";
import { deliverTalk, ProtocolErrors } from "./talk-delivery.js";
import type { RunSnapshot, SubAgentStatus } from "./types.js";

const RUN_ENTRY = "facets-run";
const MANUAL_BINDING_ENTRY = "facets-manual-profile";
export const MAX_OPEN_SUBS = 4;

function parseSnapshot(value: unknown): RunSnapshot | undefined {
	if (!value || typeof value !== "object") return;
	const item = value as Partial<RunSnapshot>;
	if (item.version !== 1 || typeof item.runId !== "string" || typeof item.mainSessionId !== "string"
		|| typeof item.title !== "string" || typeof item.cwd !== "string"
		|| typeof item.profileName !== "string" || typeof item.channelDir !== "string"
		|| typeof item.createdAt !== "number" || typeof item.updatedAt !== "number") return;
	if (item.surface && item.surface.adapter !== "herdr") return;
	return {
		version: 1,
		runId: item.runId,
		mainSessionId: item.mainSessionId,
		title: item.title,
		cwd: item.cwd,
		profileName: item.profileName,
		...(item.origin === "manual" ? { origin: "manual" as const } : {}),
		...(typeof item.purpose === "string" ? { purpose: item.purpose } : {}),
		sessionPersistence: item.sessionPersistence === "persistent" ? "persistent" : "ephemeral",
		channelDir: item.channelDir,
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
		...(typeof item.closedAt === "number" ? { closedAt: item.closedAt } : {}),
		...(typeof item.subSessionId === "string" ? { subSessionId: item.subSessionId } : {}),
		...(typeof item.subSessionFile === "string" ? { subSessionFile: item.subSessionFile } : {}),
		...(item.surface ? { surface: item.surface } : {}),
	};
}

export class MainRunManager {
	readonly runs = new Map<string, RunSnapshot>();
	private readonly titles = new Map<string, string>();
	private readonly adapters: AdapterRegistry;
	private readonly closedRuns = new Map<string, RunSnapshot>();
	private readonly pollErrors = new ProtocolErrors();
	private readonly monitor: ChannelMonitor;
	private eventsBound = false;
	private ctx?: ExtensionContext;
	private sessionId?: string;
	private readonly history = new Map<string, RunSnapshot>();
	private readonly manualBindings = new Map<string, string>();
	private manualQueue: Promise<void> = Promise.resolve();
	private manualLifetime = new AbortController();

	constructor(private readonly pi: ExtensionAPI) {
		this.adapters = new AdapterRegistry(pi);
		this.monitor = new ChannelMonitor(
			(ids) => this.poll(ids),
			(id, error) => {
				if (this.ctx) this.pollErrors.report(this.ctx, `watch:${id}`, new Error(`File watching unavailable; the 5-second scan remains active. ${error instanceof Error ? error.message : String(error)}`));
			},
			(id) => this.pollErrors.clear(`watch:${id}`),
		);
	}

	start(ctx: ExtensionContext): void {
		const sessionId = ctx.sessionManager.getSessionId();
		if (this.sessionId && this.sessionId !== sessionId) {
			this.manualLifetime.abort();
			this.monitor.stop();
			this.runs.clear();
			this.closedRuns.clear();
			this.titles.clear();
			this.history.clear();
			this.manualBindings.clear();
		}
		if (this.manualLifetime.signal.aborted) this.manualLifetime = new AbortController();
		this.sessionId = sessionId;
		this.ctx = ctx;
		if (!this.eventsBound) {
			bindInboxEvents(this.pi, () => this.ctx, () => this.monitor.wakeAll());
			this.eventsBound = true;
		}
		this.restore(ctx);
		for (const run of [...this.runs.values(), ...this.closedRuns.values()]) this.monitor.add(run.runId, run.channelDir, "to-main");
		this.monitor.start();
		this.poll();
	}

	shutdown(): void {
		this.manualLifetime.abort();
		this.monitor.stop();
		this.ctx = undefined;
	}

	private restore(ctx: ExtensionContext): void {
		const latest = new Map<string, RunSnapshot>();
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === MANUAL_BINDING_ENTRY) {
				const binding = entry.data as { mainSessionId?: string; profileName?: string; runId?: string } | undefined;
				if (binding?.mainSessionId === ctx.sessionManager.getSessionId() && typeof binding.profileName === "string" && typeof binding.runId === "string") {
					this.manualBindings.set(binding.profileName, binding.runId);
				}
			}
			if (entry.type !== "custom" || entry.customType !== RUN_ENTRY) continue;
			const snapshot = parseSnapshot(entry.data);
			if (snapshot && (snapshot.origin !== "manual" || snapshot.mainSessionId === ctx.sessionManager.getSessionId())) latest.set(snapshot.runId, snapshot);
		}
		for (const run of latest.values()) {
			this.history.set(run.runId, run);
			this.titles.set(run.runId, run.title);
			if (fs.existsSync(run.channelDir)) {
				(run.closedAt === undefined ? this.runs : this.closedRuns).set(run.runId, run);
			}
		}
	}

	private save(run: RunSnapshot): void {
		run.updatedAt = Date.now();
		this.history.set(run.runId, run);
		if (run.closedAt === undefined) {
			this.runs.set(run.runId, run);
			this.closedRuns.delete(run.runId);
		} else {
			this.runs.delete(run.runId);
			this.closedRuns.set(run.runId, run);
		}
		this.titles.set(run.runId, run.title);
		this.pi.appendEntry(RUN_ENTRY, { ...run });
		this.monitor.add(run.runId, run.channelDir, "to-main");
		this.monitor.wake(run.runId);
	}

	titleFor(runId: string): string | undefined {
		const open = this.runs.get(runId) ?? [...this.runs.values()].find((run) => run.runId.startsWith(runId));
		if (open) {
			this.titles.set(open.runId, open.title);
			return open.title;
		}
		return this.titles.get(runId) ?? [...this.titles].find(([id]) => id.startsWith(runId))?.[1];
	}

	private findRun(runId: string): RunSnapshot {
		const exact = this.runs.get(runId);
		if (exact) return exact;
		const matches = [...this.runs.values()].filter((candidate) => candidate.runId.startsWith(runId));
		if (matches.length > 1) throw new Error(`Ambiguous Sub prefix '${runId}'. Use a longer run ID.`);
		if (!matches[0]) throw new Error(`Unknown Sub '${runId}'.`);
		return matches[0];
	}

	async delegate(input: {
		title: string;
		task: string;
		cwd: string;
		profile: ResolvedProfile;
		resumeSessionId?: string;
		origin?: "manual";
	}, signal?: AbortSignal): Promise<RunSnapshot> {
		if (!this.ctx) throw new Error("Facets is not attached to an active Main session.");
		if (input.profile.invocation === "manual" && input.origin !== "manual") throw new Error("This profile is user-invoked only; use its slash command.");
		if (this.runs.size >= MAX_OPEN_SUBS) throw new Error(`Facets allows at most ${MAX_OPEN_SUBS} open Subs.`);
		const resume = input.resumeSessionId ? await resolveResumableSubSession(input.resumeSessionId, input.origin === "manual") : undefined;
		if (resume && input.profile.sessionPersistence !== "persistent") {
			throw new Error(`Profile '${input.profile.name}' must use sessionPersistence 'persistent' when resuming a Sub session.`);
		}
		if (resume && [...this.runs.values()].some((run) => run.subSessionId === resume.sessionId)) {
			throw new Error(`Persistent Sub session '${resume.sessionId}' is already open.`);
		}
		const runId = randomUUID();
		const mainSessionId = this.ctx.sessionManager.getSessionId();
		const projectTrusted = this.ctx.isProjectTrusted();
		const cwd = resume?.cwd ?? input.cwd;
		const channel = createChannel({
			runId,
			mainSessionId,
			title: input.title,
			task: input.task,
			cwd,
			profile: input.profile,
			...(input.origin ? { origin: input.origin } : {}),
		});
		const run: RunSnapshot = {
			version: 1,
			runId,
			mainSessionId,
			title: input.title,
			cwd,
			profileName: input.profile.name,
			...(input.origin ? { origin: input.origin, purpose: input.profile.description } : {}),
			sessionPersistence: input.profile.sessionPersistence ?? "ephemeral",
			channelDir: channel.channelDir,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			...(resume ? { subSessionId: resume.sessionId, subSessionFile: resume.sessionFile } : {}),
		};
		try {
			this.save(run);
			const adapter = await this.adapters.resolve();
			const entryPath = fileURLToPath(new URL("./index.ts", import.meta.url));
			run.surface = await adapter.launch({
				runId,
				mainSessionId,
				title: input.title,
				task: input.task,
				cwd,
				projectTrusted,
				...(input.origin ? { origin: input.origin } : {}),
				...(resume ? { resumeSessionId: resume.sessionId } : {}),
				profile: input.profile,
				channelDir: channel.channelDir,
				token: channel.token,
				entryPath,
			}, signal);
			const session = readSubSessionInfo(run.channelDir, channel);
			if (session) {
				run.subSessionId = session.sessionId;
				run.subSessionFile = session.sessionFile;
			}
			this.save(run);
			if (input.origin === "manual") {
				this.pi.appendEntry(MANUAL_BINDING_ENTRY, { mainSessionId, profileName: input.profile.name, runId });
				this.manualBindings.set(input.profile.name, runId);
			}
			return run;
		} catch (error) {
			let cleanupFailure: unknown;
			if (error instanceof HerdrLaunchCleanupError) {
				run.surface = error.handle;
				cleanupFailure = error;
			} else if (run.surface) {
				try { await this.adapters.close(run.surface); } catch (cleanup) { cleanupFailure = cleanup; }
			}
			if (cleanupFailure) {
				let persistenceFailure = "";
				try { this.save(run); } catch (persist) { persistenceFailure = ` Recovery state could not be persisted: ${persist instanceof Error ? persist.message : String(persist)}.`; }
				const original = error instanceof Error ? error.message : String(error);
				const cleanup = cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure);
				const failure = error === cleanupFailure ? original : `${original} Cleanup failed: ${cleanup}`;
				throw new Error(`${failure} Sub run ${run.runId} remains open.${persistenceFailure} Use close_sub to retry.`, { cause: error });
			}
			this.retainClosed(run, "The Sub launch did not complete.");
			throw error;
		}
	}

	/** Commands serialize launch/reuse so two invocations cannot create two sessions. */
	invokeProfile(input: { profile: ResolvedProfile; task: string; cwd: string }): Promise<{ run: RunSnapshot; action: "created" | "resumed" | "queued" }> {
		const owner = this.ctx?.sessionManager.getSessionId();
		const signal = this.manualLifetime.signal;
		const pending = this.manualQueue.then(async () => {
			signal.throwIfAborted();
			if (!owner || this.ctx?.sessionManager.getSessionId() !== owner) throw new Error("The Main session changed before the profile command ran.");
			const recoverable = [...this.runs.values()].filter((run) => run.origin === "manual" && run.mainSessionId === owner && run.profileName === input.profile.name);
			if (recoverable.length > 1) throw new Error("Multiple manual runs need cleanup before this profile can be invoked again.");
			const bound = this.manualBindings.get(input.profile.name) ?? recoverable[0]?.runId;
			const previous = bound ? this.history.get(bound) : undefined;
			if (bound && (!previous || previous.mainSessionId !== owner || previous.origin !== "manual" || previous.profileName !== input.profile.name)) throw new Error("The saved profile binding is unavailable; refusing to create a replacement session.");
			if (previous && fs.existsSync(previous.channelDir)) {
				const manifest = readManifest(previous.channelDir);
				const session = readSubSessionInfo(previous.channelDir, manifest);
				if (session) {
					previous.subSessionId = session.sessionId;
					previous.subSessionFile = session.sessionFile;
					this.save(previous);
				}
				if (previous.closedAt === undefined && readSubClosed(previous.channelDir, manifest)) {
					this.retainClosed(previous, "The user-invoked Sub was closed.");
				}
			}
			const task = `[User-invoked profile: ${input.profile.name}]\nThe user explicitly requests this task:\n${input.task}`;
			if (previous && previous.closedAt === undefined && fs.existsSync(previous.channelDir)) {
				const status = await this.adapters.status(previous.surface);
				if (status === "unknown") {
					if (await this.adapters.exists(previous.surface) !== false) throw new Error("Cannot verify the existing Sub is available. Close its tab before retrying; no duplicate session was created.");
					this.retainClosed(previous, "Herdr confirmed that the Sub tab is closed.");
				} else {
					signal.throwIfAborted();
					this.talk(previous.runId, task);
					return { run: previous, action: "queued" as const };
				}
			}
			if (previous && previous.closedAt === undefined && !fs.existsSync(previous.channelDir)) {
				if (await this.adapters.exists(previous.surface) !== false) throw new Error("The existing Sub channel is missing and its tab is not confirmed closed; refusing to open the session twice.");
				this.finishClosed(previous);
			}
			if (previous?.sessionPersistence === "persistent") {
				if (input.profile.sessionPersistence !== "persistent") throw new Error("This profile already has a persistent binding; keep sessionPersistence set to persistent to reuse it.");
				if (!previous.subSessionId) throw new Error("The previous Sub session ID was not recorded; refusing to create a replacement session.");
			}
			const resumeSessionId = previous?.sessionPersistence === "persistent" ? previous.subSessionId : undefined;
			const run = await this.delegate({
				title: input.profile.name, task, cwd: input.cwd, profile: input.profile, origin: "manual",
				...(resumeSessionId ? { resumeSessionId } : {}),
			}, signal);
			return { run, action: resumeSessionId ? "resumed" as const : "created" as const };
		});
		this.manualQueue = pending.then(() => {}, () => {});
		return pending;
	}

	talk(runId: string, message: string): { run: RunSnapshot; messageId: string } {
		const run = this.findRun(runId);
		const manifest = readManifest(run.channelDir);
		const sent = talkToSub(run.channelDir, manifest, message);
		return { run, messageId: sent.id };
	}

	async subs(all = false): Promise<{
		open: Array<{ run: RunSnapshot; status: SubAgentStatus }>;
		resumable: Awaited<ReturnType<typeof listResumableSubSessions>>;
	}> {
		const runs = [...this.runs.values()];
		const activeSessionIds = new Set(runs.flatMap((run) => run.subSessionId ? [run.subSessionId] : []));
		const [open, resumable] = await Promise.all([
			Promise.all(runs.map(async (run) => ({ run, status: await this.adapters.status(run.surface) }))),
			listResumableSubSessions(activeSessionIds),
		]);
		const manual = [...this.manualBindings.values()].flatMap((id) => {
			const run = this.history.get(id);
			return run?.subSessionId && run.subSessionFile && !activeSessionIds.has(run.subSessionId) && fs.existsSync(run.subSessionFile)
				? [{ sessionId: run.subSessionId, sessionFile: run.subSessionFile, title: run.title, cwd: run.cwd, modifiedAt: run.updatedAt, origin: "manual" as const, profileName: run.profileName, purpose: run.purpose }]
				: [];
		});
		return {
			open: all ? open : open.filter(({ run, status }) => run.sessionPersistence === "persistent" || status === "working" || status === "blocked"),
			resumable: [...resumable, ...manual],
		};
	}

	interrupt(runId: string): RunSnapshot {
		const run = this.findRun(runId);
		const manifest = readManifest(run.channelDir);
		const turn = readActiveTurn(run.channelDir, manifest);
		if (!turn) throw new Error(`Sub '${run.title}' has no active turn to interrupt.`);
		writeInterrupt(run.channelDir, manifest, turn);
		return run;
	}

	async close(runId: string, reason: string): Promise<RunSnapshot> {
		const run = this.findRun(runId);
		try {
			const manifest = readManifest(run.channelDir);
			writeClose(run.channelDir, manifest, reason);
		} catch {}
		await this.adapters.close(run.surface);
		this.retainClosed(run, reason);
		return run;
	}

	private retainClosed(run: RunSnapshot, reason: string): void {
		run.closedAt = Date.now();
		try {
			const manifest = readManifest(run.channelDir);
			const session = readSubSessionInfo(run.channelDir, manifest);
			if (session) { run.subSessionId = session.sessionId; run.subSessionFile = session.sessionFile; }
			// Preserve the closure fact even if session persistence later fails.
			writeSubClosed(run.channelDir, manifest, reason);
			if (listTalkToMain(run.channelDir, manifest).length === 0) {
				this.finishClosed(run);
				return;
			}
		} catch (error) { this.reportChannelError(run, error); }
		// A closed surface with a pending or broken inbox is not an open Sub.
		this.save(run);
	}

	private reportChannelError(run: RunSnapshot, error: unknown): void {
		if (this.ctx) this.pollErrors.report(this.ctx, run.runId, error);
		else console.error(`Facets channel error (${run.runId}): ${error instanceof Error ? error.message : String(error)}`);
	}

	private finishClosed(run: RunSnapshot): void {
		if (run.origin === "manual") {
			run.closedAt ??= Date.now();
			this.save(run); // Keep the persistent identity after the runtime channel is removed.
		}
		removeChannel(run.channelDir);
		this.monitor.remove(run.runId);
		this.runs.delete(run.runId);
		this.closedRuns.delete(run.runId);
		this.pollErrors.clear(run.runId);
	}

	private poll(ids?: string[]): void {
		const ctx = this.ctx;
		if (!ctx) return;
		const runs = ids ? ids.flatMap((id) => {
			const run = this.runs.get(id) ?? this.closedRuns.get(id);
			return run ? [run] : [];
		}) : [...this.runs.values(), ...this.closedRuns.values()];
		for (const run of runs) {
			try {
				const manifest = readManifest(run.channelDir);
				if (manifest.runId !== run.runId || manifest.mainSessionId !== run.mainSessionId) throw new Error("Channel manifest identity mismatch.");
				const session = readSubSessionInfo(run.channelDir, manifest);
				if (session && (run.subSessionId !== session.sessionId || run.subSessionFile !== session.sessionFile)) {
					run.subSessionId = session.sessionId;
					run.subSessionFile = session.sessionFile;
					this.save(run);
				}
				if (run.closedAt === undefined && readSubClosed(run.channelDir, manifest)) {
					run.closedAt = Date.now();
					this.save(run);
				}
				const messages = listTalkToMain(run.channelDir, manifest);
				let pending = messages.length;
				for (const message of messages) {
					const content = `[Facets Sub message]${run.origin === "manual" ? `\n[User-invoked specialist: ${run.profileName}]\n${run.purpose ? `Purpose: ${run.purpose}\n` : ""}${MANUAL_MAIN_GUIDANCE}` : ""}\nSub '${run.title}' (${run.runId}) says:\n${message.message}\n\n${run.closedAt === undefined ? `Use talk with runId '${run.runId}' to respond, or close_sub when the delivery is accepted and no more work is needed.` : "This Sub has already closed; this is a retained final delivery."}`;
					const result = deliverTalk(this.pi, ctx, run.channelDir, manifest, "to-main", message, content);
					if (result === "acknowledged") pending--;
				}
				if (run.closedAt !== undefined && pending === 0) this.finishClosed(run);
				this.pollErrors.clear(run.runId);
			} catch (error) {
				this.pollErrors.report(ctx, run.runId, error);
			}
		}
	}
}

export { RUN_ENTRY };
