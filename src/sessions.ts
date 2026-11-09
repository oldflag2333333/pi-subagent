import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { RunSnapshot } from "./types.js";

export const SUB_OWNER_ENTRY = "subagent-owner";
export const SUB_SESSION_ID = /^sub-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface SubSessionOwner {
	version: 1;
	subSessionId: string;
	mainSessionId: string;
	mainSessionFile?: string;
}

export function parseSubSessionOwner(value: unknown): SubSessionOwner {
	const owner = value as Partial<SubSessionOwner> | undefined;
	if (!owner || owner.version !== 1 || typeof owner.subSessionId !== "string"
		|| typeof owner.mainSessionId !== "string" || !owner.mainSessionId
		|| (owner.mainSessionFile !== undefined && typeof owner.mainSessionFile !== "string")) {
		throw new Error("Invalid Sub session owner metadata.");
	}
	return owner as SubSessionOwner;
}

/** Ownership is session-wide, not branch-relative. Never silently reassign a Sub. */
export function recordSubSessionOwner(pi: ExtensionAPI, ctx: ExtensionContext, mainSessionId: string, mainSessionFile?: string): void {
	const subSessionId = ctx.sessionManager.getSessionId();
	const entries = ctx.sessionManager.getEntries().filter((entry): entry is SessionEntry & { type: "custom" } =>
		entry.type === "custom" && entry.customType === SUB_OWNER_ENTRY);
	let previous: SubSessionOwner | undefined;
	for (const entry of entries) {
		const owner = parseSubSessionOwner(entry.data);
		if (owner.subSessionId !== subSessionId || owner.mainSessionId !== mainSessionId) {
			throw new Error("Sub session owner does not match this Main.");
		}
		previous = owner;
	}
	if (!previous || previous.mainSessionFile !== mainSessionFile) {
		pi.appendEntry(SUB_OWNER_ENTRY, { version: 1, subSessionId, mainSessionId, ...(mainSessionFile ? { mainSessionFile } : {}) } satisfies SubSessionOwner);
	}
}

export interface ResumableSubSession {
	sessionId: string;
	sessionFile: string;
	title: string;
	cwd: string;
	modifiedAt: number;
	origin?: "manual";
	profileName?: string;
	purpose?: string;
}

/** Only confirmed-closed sessions recorded by this Main are eligible. */
export function selectResumableSubSessions(runs: Iterable<RunSnapshot>, mainSessionId: string): ResumableSubSession[] {
	const owned = [...runs].filter((run) => run.mainSessionId === mainSessionId);
	// A missing channel is not proof of closure. An unclosed run still blocks resume.
	const activeIds = new Set(owned.filter((run) => run.closedAt === undefined).map((run) => run.subSessionId));
	const latest = new Map<string, RunSnapshot>();
	for (const run of owned) {
		if (run.sessionPersistence !== "persistent" || run.closedAt === undefined || !run.subSessionId || !run.subSessionFile
			|| activeIds.has(run.subSessionId)) continue;
		const previous = latest.get(run.subSessionId);
		if (!previous || run.createdAt > previous.createdAt || (run.createdAt === previous.createdAt && run.updatedAt >= previous.updatedAt)) {
			latest.set(run.subSessionId, run);
		}
	}
	return [...latest.values()].flatMap((run) => {
		try {
			if (!fs.statSync(run.subSessionFile!).isFile()) return [];
		} catch { return []; }
		return [{
			sessionId: run.subSessionId!, sessionFile: run.subSessionFile!, title: run.title, cwd: run.cwd,
			modifiedAt: run.updatedAt, profileName: run.profileName,
			...(run.origin ? { origin: run.origin } : {}),
			...(run.purpose ? { purpose: run.purpose } : {}),
		}];
	}).sort((left, right) => right.modifiedAt - left.modifiedAt || left.sessionId.localeCompare(right.sessionId));
}

export function resolveResumableSubSession(sessionId: string, candidates: ResumableSubSession[], includeManual = false): ResumableSubSession {
	const sessions = candidates.filter((session) => includeManual || session.origin !== "manual");
	const exact = sessions.find((session) => session.sessionId === sessionId);
	if (exact) return exact;
	const matches = sessions.filter((session) => session.sessionId.startsWith(sessionId));
	if (matches.length === 0) throw new Error(`No persistent Sub session belonging to this Main matches '${sessionId}'.`);
	if (matches.length > 1) throw new Error(`Persistent Sub session id '${sessionId}' is ambiguous.`);
	return matches[0]!;
}
