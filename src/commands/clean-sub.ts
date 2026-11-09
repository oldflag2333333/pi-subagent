import * as fs from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { channelPath, readManifest, runtimeRoot } from "../channel.js";
import { parseSubSessionOwner, SUB_OWNER_ENTRY, SUB_SESSION_ID, type SubSessionOwner } from "../sessions.js";

interface SavedSession {
	file: string;
	id: string;
	cwd: string;
	owner?: SubSessionOwner;
}

interface CleanupResult {
	removed: number;
	removedChannels: number;
	errors: string[];
}

function entries(directory: string): fs.Dirent[] {
	try { return fs.readdirSync(directory, { withFileTypes: true }); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

function sessionDirectories(currentSessionDir: string): string[] {
	const root = path.join(getAgentDir(), "sessions");
	const directories = new Set([root, ...(currentSessionDir ? [path.resolve(currentSessionDir)] : [])]);
	for (const entry of entries(root)) {
		if (entry.isDirectory() || entry.isSymbolicLink()) directories.add(path.join(root, entry.name));
	}
	return [...directories];
}

/** Read headers only for Mains; stream Sub ownership without loading transcripts into memory. */
async function inspectSession(file: string, scopeCwd?: string, headerOnly = false): Promise<SavedSession | undefined> {
	const input = fs.createReadStream(file, { encoding: "utf8" });
	const lines = createInterface({ input, crlfDelay: Infinity });
	let session: SavedSession | undefined;
	try {
		for await (const line of lines) {
			if (!session) {
				const header = JSON.parse(line);
				if (header?.type !== "session" || typeof header.id !== "string" || !header.id
					|| typeof header.cwd !== "string" || !path.isAbsolute(header.cwd)) throw new Error("Invalid session header");
				session = { file, id: header.id, cwd: header.cwd };
				if (headerOnly || !SUB_SESSION_ID.test(session.id) || (scopeCwd && path.resolve(session.cwd) !== scopeCwd)) break;
				continue;
			}
			if (!line.includes(SUB_OWNER_ENTRY)) continue;
			const entry = JSON.parse(line);
			if (entry?.type !== "custom" || entry.customType !== SUB_OWNER_ENTRY) continue;
			const owner = parseSubSessionOwner(entry.data);
			if (owner.subSessionId !== session.id || owner.mainSessionId === session.id
				|| (owner.mainSessionFile !== undefined && !path.isAbsolute(owner.mainSessionFile))) throw new Error("Invalid Sub session ownership");
			if (session.owner && session.owner.mainSessionId !== owner.mainSessionId) {
				throw new Error("Conflicting Sub session owners");
			}
			session.owner = owner;
		}
		if (!session) throw new Error("Missing session header");
		return session;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`Cannot inspect session ${file}: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		lines.close();
		input.destroy();
	}
}

/** Global discovery establishes Main liveness even when only one cwd is being cleaned. */
export async function cleanSubFiles(currentSessionId: string, currentSessionDir: string, cwd?: string): Promise<CleanupResult> {
	const scopeCwd = cwd ? path.resolve(cwd) : undefined;
	const live = new Set([currentSessionId]); // Includes unsaved/in-memory current sessions.
	const sessions: SavedSession[] = [];
	const errors: string[] = [];
	const ownerFiles = new Map<string, string>();
	for (const directory of sessionDirectories(currentSessionDir)) {
		const files = entries(directory);
		if (files.length && fs.lstatSync(directory).isSymbolicLink()) throw new Error(`Refusing to clean symlinked directory: ${directory}`);
		for (const entry of files) {
			if (!entry.name.endsWith(".jsonl")) continue;
			const file = path.join(directory, entry.name);
			// A linked Main still establishes liveness, but links are never deletion targets.
			const session = await inspectSession(file, scopeCwd);
			if (!session) continue;
			live.add(session.id);
			if (session.owner?.mainSessionFile) ownerFiles.set(session.owner.mainSessionFile, session.owner.mainSessionId);
			if (entry.isFile() && SUB_SESSION_ID.test(session.id) && (!scopeCwd || path.resolve(session.cwd) === scopeCwd)) {
				if (session.owner) sessions.push(session);
				else errors.push(`Preserved Sub without owner metadata: ${file}`);
			}
		}
	}

	const channels: Array<{ directory: string; mainSessionId: string }> = [];
	const runtime = runtimeRoot();
	const owners = entries(runtime);
	if (owners.length && fs.lstatSync(runtime).isSymbolicLink()) throw new Error(`Refusing to clean symlinked directory: ${runtime}`);
	for (const owner of owners) {
		if (!owner.isDirectory()) continue;
		const ownerDir = path.join(runtime, owner.name);
		for (const run of entries(ownerDir)) {
			if (!run.isDirectory()) continue;
			const directory = path.join(ownerDir, run.name);
			const manifest = readManifest(directory);
			if (path.resolve(channelPath(manifest.mainSessionId, manifest.runId)) !== path.resolve(directory)) throw new Error(`Invalid channel identity: ${directory}`);
			if (scopeCwd && path.resolve(manifest.cwd) !== scopeCwd) continue;
			if (manifest.mainSessionFile) ownerFiles.set(manifest.mainSessionFile, manifest.mainSessionId);
			channels.push({ directory, mainSessionId: manifest.mainSessionId });
		}
	}
	// Recorded paths also protect Mains using a custom store outside native discovery.
	for (const [file, id] of ownerFiles) {
		if (live.has(id)) continue;
		const main = await inspectSession(file, undefined, true);
		if (main?.id === id) live.add(id);
	}

	let removed = 0;
	let removedChannels = 0;
	// Discovery must finish successfully before any destructive operation.
	for (const session of sessions) {
		if (session.id === currentSessionId || live.has(session.owner!.mainSessionId)) continue;
		try {
			if (!fs.lstatSync(session.file).isFile()) continue;
			fs.unlinkSync(session.file);
			removed++;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(`${session.file}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	for (const channel of channels) {
		if (live.has(channel.mainSessionId)) continue;
		try {
			if (!fs.lstatSync(channel.directory).isDirectory()) continue;
			fs.rmSync(channel.directory, { recursive: true, force: true });
			removedChannels++;
			try { fs.rmdirSync(path.dirname(channel.directory)); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY" && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(`${channel.directory}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { removed, removedChannels, errors };
}

export function registerCleanSubCommand(pi: ExtensionAPI, owningMainId?: string): void {
	pi.registerCommand("clean-sub", {
		description: "Delete orphaned Sub sessions across Pi's native session store and orphaned communication files.",
		handler: async (_args, ctx) => {
			try {
				const result = await cleanSubFiles(owningMainId ?? ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionDir());
				ctx.ui.notify([
					`Removed ${result.removed} orphaned Sub sessions and ${result.removedChannels} communication directories.`,
					...result.errors,
				].join("\n"), result.errors.length ? "warning" : "info");
			} catch (error) {
				ctx.ui.notify(`Cleanup aborted: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
	pi.on("session_shutdown", async (event, ctx) => {
		if (event.reason !== "quit") return;
		try {
			const result = await cleanSubFiles(owningMainId ?? ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionDir(), ctx.cwd);
			if (result.errors.length) ctx.ui.notify(`Sub cleanup: ${result.errors.join("\n")}`, "warning");
		} catch (error) {
			ctx.ui.notify(`Sub cleanup aborted: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	});
}
