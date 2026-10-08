import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";

import { MANUAL_SUB_PREFIX } from "./manual-context.js";

const SUB_SESSION_PREFIX = "[sub] ";

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

function subSession(info: SessionInfo, includeManual = false): ResumableSubSession | undefined {
	const prefix = includeManual && info.name?.startsWith(MANUAL_SUB_PREFIX) ? MANUAL_SUB_PREFIX : SUB_SESSION_PREFIX;
	if (!info.name?.startsWith(prefix) || !info.cwd) return;
	const title = info.name.slice(prefix.length).trim();
	if (!title) return;
	return {
		sessionId: info.id,
		sessionFile: info.path,
		title,
		cwd: info.cwd,
		modifiedAt: info.modified.getTime(),
	};
}

export function selectResumableSubSessions(infos: SessionInfo[], activeSessionIds = new Set<string>()): ResumableSubSession[] {
	return infos
		.map((info) => subSession(info))
		.filter((session): session is ResumableSubSession => session !== undefined)
		.filter((session) => !activeSessionIds.has(session.sessionId))
		.sort((left, right) => right.modifiedAt - left.modifiedAt || left.sessionId.localeCompare(right.sessionId));
}

export async function listResumableSubSessions(activeSessionIds = new Set<string>()): Promise<ResumableSubSession[]> {
	return selectResumableSubSessions(await SessionManager.listAll(), activeSessionIds);
}

export async function resolveResumableSubSession(sessionId: string, includeManual = false): Promise<ResumableSubSession> {
	const sessions = (await SessionManager.listAll()).map((info) => subSession(info, includeManual)).filter((session): session is ResumableSubSession => Boolean(session));
	const exact = sessions.find((session) => session.sessionId === sessionId);
	if (exact) return exact;
	const matches = sessions.filter((session) => session.sessionId.startsWith(sessionId));
	if (matches.length === 0) throw new Error(`No persistent Sub session matches '${sessionId}'.`);
	if (matches.length > 1) throw new Error(`Persistent Sub session id '${sessionId}' is ambiguous.`);
	return matches[0]!;
}
