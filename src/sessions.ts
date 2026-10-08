import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { RunSnapshot } from "./types.js";

export function subSessionsRoot(): string {
	return path.join(getAgentDir(), "subagent", "sessions");
}

export function subSessionDir(mainSessionId: string): string {
	if (!mainSessionId || mainSessionId === "." || mainSessionId === "..") throw new Error("Invalid Main session ID.");
	return path.join(subSessionsRoot(), encodeURIComponent(mainSessionId));
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
