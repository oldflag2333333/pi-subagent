import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { channelPath, runtimeRoot } from "../channel.js";
import { subSessionDir, subSessionsRoot } from "../sessions.js";

function entries(directory: string): fs.Dirent[] {
	try { return fs.readdirSync(directory, { withFileTypes: true }); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

/** Read only the header; never load transcripts or treat an unreadable session as deleted. */
function sessionId(file: string): string {
	const fd = fs.openSync(file, "r");
	try {
		const buffer = Buffer.alloc(64 * 1024);
		const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
		const text = buffer.subarray(0, length).toString("utf8");
		const header = JSON.parse(text.split("\n", 1)[0]!);
		if (header?.type !== "session" || typeof header.id !== "string" || !header.id) throw new Error("Invalid session header");
		return header.id;
	} catch (error) {
		throw new Error(`Cannot inspect session ${file}: ${error instanceof Error ? error.message : String(error)}`);
	} finally { fs.closeSync(fd); }
}

export function cleanSubFiles(currentMainId: string, currentSessionDir: string): { removed: number; errors: string[] } {
	const stores = [
		{ root: runtimeRoot(), ownerDirectory: (id: string) => path.basename(path.dirname(channelPath(id, "unused"))) },
		{ root: subSessionsRoot(), ownerDirectory: (id: string) => path.basename(subSessionDir(id)) },
	].map((store) => {
		const candidates = entries(store.root).filter((entry) => entry.isDirectory());
		if (candidates.length && fs.lstatSync(store.root).isSymbolicLink()) throw new Error(`Refusing to clean symlinked directory: ${store.root}`);
		return { ...store, candidates };
	});
	if (stores.every((store) => store.candidates.length === 0)) return { removed: 0, errors: [] };

	const sessionsRoot = path.join(getAgentDir(), "sessions");
	const directories = new Set([sessionsRoot]);
	if (currentSessionDir) directories.add(currentSessionDir);
	for (const entry of entries(sessionsRoot)) {
		const file = path.join(sessionsRoot, entry.name);
		if (entry.isDirectory() || (entry.isSymbolicLink() && fs.statSync(file).isDirectory())) directories.add(file);
	}
	const live = new Set([currentMainId]);
	// Complete discovery before deleting anything. A read/parse error aborts cleanup.
	for (const directory of directories) {
		for (const entry of entries(directory)) {
			if (entry.name.endsWith(".jsonl")) live.add(sessionId(path.join(directory, entry.name)));
		}
	}
	let removed = 0;
	const errors: string[] = [];
	for (const store of stores) {
		const liveDirectories = new Set([...live].map(store.ownerDirectory));
		for (const entry of store.candidates) {
			if (liveDirectories.has(entry.name)) continue;
			const directory = path.join(store.root, entry.name);
			try {
				// Do not follow a directory replaced with a symlink during discovery.
				if (!fs.lstatSync(directory).isDirectory()) continue;
				fs.rmSync(directory, { recursive: true, force: true });
				removed++;
			} catch (error) {
				errors.push(`${directory}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	return { removed, errors };
}

export function registerCleanSubCommand(pi: ExtensionAPI): void {
	pi.registerCommand("clean-sub", {
		description: "Delete managed Sub sessions and communication directories whose Main session can no longer be found.",
		handler: async (_args, ctx) => {
			try {
				const result = cleanSubFiles(ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionDir());
				ctx.ui.notify([
					`Removed ${result.removed} orphaned Sub data directories (sessions and communication).`,
					...result.errors,
				].join("\n"), result.errors.length ? "warning" : "info");
			} catch (error) {
				ctx.ui.notify(`Cleanup aborted: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
