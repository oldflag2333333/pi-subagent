import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { resolveProfile } from "../profiles/loader.js";
import { resolveToolExtensions } from "../profiles/tool-sources.js";
import { MAX_OPEN_SUBS, type MainRunManager } from "../run-manager.js";
import { MANUAL_MAIN_GUIDANCE } from "../manual-context.js";
import { talkView } from "../talk-render.js";
import type { SubAgentStatus } from "../types.js";

function normalizeTitle(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 48) || "delegated task";
}

function findSubTitle(manager: MainRunManager, runId: unknown): string | undefined {
	return typeof runId === "string" && runId ? manager.titleFor(runId) : undefined;
}

function formatElapsed(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 86_400) {
		const hours = Math.floor(seconds / 3600);
		const minutes = Math.floor((seconds % 3600) / 60);
		return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	}
	const days = Math.floor(seconds / 86_400);
	const hours = Math.floor((seconds % 86_400) / 3600);
	return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

function compactCapabilityList(values: string[], maxCharacters = 160): string {
	if (values.length === 0) return "(none)";
	const visible: string[] = [];
	let length = 0;
	for (const value of values) {
		const addition = (visible.length > 0 ? 3 : 0) + value.length;
		if (length + addition > maxCharacters) {
			if (visible.length === 0) visible.push(`${value.slice(0, Math.max(1, maxCharacters - 1))}…`);
			break;
		}
		visible.push(value);
		length += addition;
	}
	const omitted = values.length - visible.length;
	return `${visible.join(" · ")}${omitted > 0 ? ` · +${omitted}` : ""}`;
}

export function registerMainTools(pi: ExtensionAPI, manager: MainRunManager): void {
	pi.registerTool({
		name: "delegate",
		label: "delegate",
		exposure: "model-only",
		description: "Create a fresh, context-isolated Sub Pi in Herdr, or resume a previous persistent Sub session by session ID. The Sub remains open until the Main calls close_sub or the user closes it manually.",
		promptSnippet: "Create or resume a focused Sub Pi in Herdr with an explicit Facets profile",
		promptGuidelines: [
			"Use delegate for work assigned by MAIN.md or a separable task that benefits from an independent context; select an explicitly configured profile and provide a short informative title.",
			"After delegate launches, do not wait or repeatedly poll. Facets will wake the Main when the Sub uses talk.",
			"For Subs labeled user-invoked specialists, follow up only on the user's task and results. Do not assign unrelated work or substitute them for general consulting profiles. New tasks are initiated by the user through a profile command.",
			"Use talk to respond to an existing Sub, interrupt_sub to stop its current turn without closing it, and close_sub only after its delivery is accepted or the user asks to close it.",
		],
		parameters: Type.Object({
			title: Type.String({ description: "Short Herdr tab title, up to 48 displayed characters." }),
			task: Type.String({ description: "Self-contained initial task. Do not assume the Sub can see the Main conversation." }),
			profile: Type.String({ description: "Configured Facets profile name. Project profiles override same-named global profiles." }),
			cwd: Type.Optional(Type.String({ description: "Sub working directory; defaults to the Main cwd and is ignored when resuming." })),
			resumeSessionId: Type.Optional(Type.String({ description: "Exact or unique-prefix Pi session ID of a previous persistent Sub to resume." })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			if (manager.runs.size >= MAX_OPEN_SUBS) throw new Error(`Facets allows at most ${MAX_OPEN_SUBS} open Subs.`);
			const title = normalizeTitle(params.title);
			const cwd = path.resolve(ctx.cwd, params.cwd ?? ".");
			const profile = resolveToolExtensions(
				resolveProfile(params.profile, ctx.cwd, ctx.isProjectTrusted(), { agentOnly: true }),
				pi.getAllTools(),
			);
			const sessionPersistence = profile.sessionPersistence ?? "ephemeral";
			const capabilityDetails = { tools: profile.tools, skills: profile.skills ?? [], sessionPersistence };
			onUpdate?.({
				content: [{ type: "text", text: `Creating Sub with profile ${profile.name}: ${title}` }],
				details: { title, profile: profile.name, ...capabilityDetails },
			});
			const run = await manager.delegate({
				title,
				task: params.task,
				cwd,
				profile,
				...(params.resumeSessionId ? { resumeSessionId: params.resumeSessionId } : {}),
			}, signal);
			return {
				content: [{ type: "text", text: `${params.resumeSessionId ? "Resumed" : "Created"} Sub: ${run.title} (profile ${run.profileName}, run ${run.runId.slice(0, 8)}${run.subSessionId ? `, session ${run.subSessionId}` : ""}).` }],
				details: {
					runId: run.runId,
					title: run.title,
					profile: run.profileName,
					adapter: run.surface?.adapter,
					...capabilityDetails,
				},
				terminate: true,
			};
		},
		renderCall(args, theme) {
			const title = normalizeTitle(args.title ?? "delegated task");
			const action = args.resumeSessionId ? "resume" : "delegate";
			return new Text(`${theme.fg("toolTitle", theme.bold(action))} ${theme.fg("muted", `· ${title}`)}`, 0, 0);
		},
		renderResult(result, { isPartial }, theme, context) {
			if (context.isError) {
				const message = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
				return new Text(theme.fg("error", message || "delegate failed"), 0, 0);
			}
			const details = result.details as {
				title?: string;
				profile?: string;
				adapter?: string;
				tools?: string[];
				skills?: string[];
				sessionPersistence?: string;
			} | undefined;
			const icon = isPartial ? theme.fg("warning", "◌") : theme.fg("success", "✓");
			const summary = `${icon} ${theme.fg("accent", details?.title ?? "sub")} ${theme.fg("muted", `· ${details?.profile ?? "profile?"} · ${details?.sessionPersistence ?? "ephemeral"}${details?.adapter ? ` · ${details.adapter}` : ""}`)}`;
			const tools = `${theme.fg("dim", "  tools ")}${theme.fg("muted", compactCapabilityList(details?.tools ?? []))}`;
			const skills = `${theme.fg("dim", "  skills")}${theme.fg("muted", ` ${compactCapabilityList(details?.skills ?? [])}`)}`;
			return new Text(`${summary}\n${tools}\n${skills}`, 0, 0);
		},
	});

	pi.registerTool({
		name: "talk",
		label: "talk",
		description: "Send one message to an existing Sub Pi. Messages enter the Sub's native follow-up queue and are processed after its current work. Format non-trivial messages as readable Markdown with paragraph breaks and lists.",
		promptSnippet: "Send a message to an existing Sub Pi",
		executionMode: "sequential",
		parameters: Type.Object({
			runId: Type.String({ description: "Full Sub run ID or a unique prefix." }),
			message: Type.String({ description: "Message to the other Agent. For non-trivial content, use readable Markdown with paragraph breaks and lists." }),
		}),
		renderCall(args, theme, context) {
			const message = typeof args.message === "string" ? args.message : "";
			const title = findSubTitle(manager, args.runId);
			const suffix = title ? ` ${theme.fg("muted", `· ${title}`)}` : "";
			const view = talkView(message, context.expanded);
			let text = `${theme.fg("accent", "›")} ${theme.fg("toolTitle", theme.bold("message send"))}${suffix}`;
			if (message) text += `\n\n${view.lines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
			if (view.remaining > 0) {
				text += theme.fg("muted", `\n... (${view.remaining} more lines, ${view.totalLines} total, ctrl+o to expand)`);
			}
			return new Text(text, 0, 0);
		},
		async execute(_id, params) {
			const { run, messageId } = manager.talk(params.runId, params.message);
			return {
				content: [{ type: "text", text: `Message queued for Sub: ${run.title}` }],
				details: { runId: run.runId, messageId },
			};
		},
		renderResult(_result, _options, theme, context) {
			if (context.isError) return new Text(theme.fg("error", "\ntalk failed"), 0, 0);
			return new Container();
		},
	});

	pi.registerTool({
		name: "interrupt_sub",
		label: "interrupt sub",
		description: "Request cancellation of an open Sub's current turn, including a running tool call, without closing its session or Herdr tab. If the tool ignores cancellation, the Sub may remain busy; use close_sub only if closure is intended.",
		parameters: Type.Object({
			runId: Type.String({ description: "Full Sub run ID or a unique prefix." }),
		}),
		renderCall(args, theme, context) {
			const state = context.state as { title?: string };
			state.title ??= findSubTitle(manager, args.runId);
			return new Text(`${theme.fg("toolTitle", theme.bold("interrupt"))} ${theme.fg("muted", `· ${state.title ?? "sub"}`)}`, 0, 0);
		},
		async execute(_id, params) {
			const run = manager.interrupt(params.runId);
			return { content: [{ type: "text", text: `Requested interruption of Sub: ${run.title}. The Sub session remains open.` }], details: { runId: run.runId } };
		},
		renderResult(_result, _options, theme, context) {
			if (context.isError) return new Text(theme.fg("error", "\ninterrupt failed"), 0, 0);
			return new Container();
		},
	});

	pi.registerTool({
		name: "close_sub",
		label: "close sub",
		description: "Close a Sub Pi session and its Herdr tab. Use after the delivery is accepted or when the user asks to close it.",
		parameters: Type.Object({
			runId: Type.String({ description: "Full Sub run ID or a unique prefix." }),
			reason: Type.Optional(Type.String({ description: "Reason for closing the Sub session." })),
		}),
		renderCall(args, theme, context) {
			const state = context.state as { title?: string };
			state.title ??= findSubTitle(manager, args.runId);
			return new Text(`${theme.fg("toolTitle", theme.bold("close"))} ${theme.fg("muted", `· ${state.title ?? "sub"}`)}`, 0, 0);
		},
		async execute(_id, params) {
			const run = await manager.close(params.runId, params.reason ?? "The Main closed the Sub session.");
			return { content: [{ type: "text", text: `Closed Sub: ${run.title}` }], details: { runId: run.runId } };
		},
		renderResult(_result, _options, theme, context) {
			if (context.isError) return new Text(theme.fg("error", "\nclose failed"), 0, 0);
			return new Container();
		},
	});

	pi.registerTool({
		name: "list_sub",
		label: "subs",
		description: "List working or blocked Subs and persistent Sub sessions by default, including closed sessions that can be resumed. Set all=true to include idle or unknown ephemeral Subs. Shows live Herdr status; never returns transcripts.",
		parameters: Type.Object({
			all: Type.Optional(Type.Boolean({ description: "Include idle and unknown ephemeral Subs too (default: false)." })),
		}),
		async execute(_id, params) {
			const now = Date.now();
			const listed = await manager.subs(params.all ?? false);
			const open = listed.open.map(({ run, status }) => ({
				runId: run.runId,
				subSessionId: run.subSessionId,
				title: run.title,
				profile: run.profileName,
				sessionPersistence: run.sessionPersistence,
				origin: run.origin,
				purpose: run.purpose,
				status,
				adapter: run.surface?.adapter,
				elapsedSeconds: Math.max(0, Math.round((now - run.createdAt) / 1000)),
			}));
			const resumable = listed.resumable.map((session) => ({
				...session,
				modifiedSecondsAgo: Math.max(0, Math.round((now - session.modifiedAt) / 1000)),
			}));
			const lines = [
				...open.map((run) => `- ${run.status} ${run.runId.slice(0, 8)} ${run.title} <${run.profile}, ${run.sessionPersistence}${run.origin === "manual" ? ", user-invoked specialist" : ""}>${run.purpose ? ` Purpose: ${run.purpose}` : ""}`),
				...resumable.map((session) => `- closed ${session.sessionId} ${session.title} <persistent, ${session.origin === "manual" ? "user-invoked; resume via user command" : "resumable"}> cwd=${session.cwd}${session.purpose ? ` Purpose: ${session.purpose}` : ""}`),
			];
			if (open.some((run) => run.origin === "manual") || resumable.some((session) => session.origin === "manual")) lines.push(MANUAL_MAIN_GUIDANCE);
			return { content: [{ type: "text", text: lines.join("\n") || "no Sub sessions." }], details: { open, resumable } };
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("subs")), 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as {
				open?: Array<{
					runId: string;
					subSessionId?: string;
					title: string;
					profile: string;
					sessionPersistence: string;
					origin?: "manual";
					status: SubAgentStatus;
					adapter?: string;
					elapsedSeconds: number;
				}>;
				resumable?: Array<{
					sessionId: string;
					title: string;
					cwd: string;
					modifiedSecondsAgo: number;
					origin?: "manual";
				}>;
			} | undefined;
			const open = details?.open ?? [];
			const resumable = details?.resumable ?? [];
			if (open.length === 0 && resumable.length === 0) return new Text(theme.fg("muted", "no Sub sessions"), 0, 0);
			const lines = [
				...open.map((run) => {
					const metadata = [
						run.runId.slice(0, 8),
						run.subSessionId?.slice(0, 8),
						run.profile,
						run.origin === "manual" ? "user-invoked specialist" : undefined,
						run.sessionPersistence,
						run.status,
						run.adapter,
						formatElapsed(run.elapsedSeconds),
					].filter(Boolean).join(" · ");
					return `${theme.fg("accent", "•")} ${theme.fg("accent", run.title)}\n  ${theme.fg("muted", metadata)}`;
				}),
				...resumable.map((session) => {
					const metadata = [
						session.sessionId.slice(0, 8),
						"persistent",
						session.origin === "manual" ? "closed · user-invoked" : "closed · resumable",
						path.basename(session.cwd),
						formatElapsed(session.modifiedSecondsAgo),
					].join(" · ");
					return `${theme.fg("dim", "○")} ${theme.fg("accent", session.title)}\n  ${theme.fg("muted", metadata)}`;
				}),
			];
			return new Text(lines.join("\n\n"), 0, 0);
		},
	});
}
