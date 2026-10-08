import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { channelPath, runtimeRoot } from "../channel.js";

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

export function cleanSubChannels(currentMainId: string, currentSessionDir: string): { removed: number; errors: string[] } {
	const root = runtimeRoot();
	const candidates = entries(root).filter((entry) => entry.isDirectory());
	if (candidates.length === 0) return { removed: 0, errors: [] };
	if (fs.lstatSync(root).isSymbolicLink()) throw new Error("Refusing to clean a symlinked runtime directory.");

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
	const liveDirectories = new Set([...live].map((id) => path.basename(path.dirname(channelPath(id, "unused")))));
	let removed = 0;
	const errors: string[] = [];
	for (const entry of candidates) {
		if (liveDirectories.has(entry.name)) continue;
		const directory = path.join(root, entry.name);
		try {
			// Do not follow a directory replaced with a symlink during discovery.
			if (!fs.lstatSync(directory).isDirectory()) continue;
			fs.rmSync(directory, { recursive: true, force: true });
			removed++;
		} catch (error) {
			errors.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { removed, errors };
}

export function registerCleanSubCommand(pi: ExtensionAPI): void {
	pi.registerCommand("clean-sub", {
		description: "Delete runtime communication files whose Main session can no longer be found; keep persistent Sub sessions.",
		handler: async (_args, ctx) => {
			try {
				const result = cleanSubChannels(ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionDir());
				ctx.ui.notify([
					`Removed ${result.removed} orphaned Main communication directories. Persistent Sub sessions were not deleted.`,
					...result.errors,
				].join("\n"), result.errors.length ? "warning" : "info");
			} catch (error) {
				ctx.ui.notify(`Cleanup aborted: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
