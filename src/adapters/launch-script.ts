import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { runtimeRoot } from "../channel.js";

// Only this fixed-size command crosses the PTY, never the path or Pi arguments.
export const LAUNCH_COMMAND = 'sh "$PI_SUBAGENT_LAUNCH"';
export const ABANDONED_LAUNCH_AGE_MS = 5 * 60_000;
const LAUNCH_FILE = /^launch-([1-9]\d*)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.sh$/;

export function launchScriptPath(channelDir: string): string {
	return path.join(channelDir, `launch-${process.pid}-${randomUUID()}.sh`);
}

export function launchScriptContent(args: readonly string[]): string {
	const quoted = args.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`);
	// The shell has opened the file by this point and can keep reading its FD
	// after unlinking it. Self-removal also works if Main has already crashed.
	return `#!/bin/sh\nrm -f -- "$0"\nunset PI_SUBAGENT_LAUNCH\nexec pi ${quoted.join(" ")}\n`;
}

function warnReapError(target: string, error: unknown): void {
	if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
	console.warn(`Pi Subagent: abandoned launch script cleanup skipped (${target}): ${error instanceof Error ? error.message : String(error)}`);
}

function entries(directory: string): fs.Dirent[] {
	try { return fs.readdirSync(directory, { withFileTypes: true }); }
	catch (error) {
		warnReapError(directory, error);
		return [];
	}
}

/** Best-effort sweep of expired launch files belonging to dead processes, never channels. */
export function reapAbandonedLaunchScripts(root = runtimeRoot(), now = Date.now()): void {
	// Directory entries, rather than stat-followed paths, keep symlinked trees
	// out of the sweep. Each run's normal channel cleanup remains independent.
	try { if (!fs.lstatSync(root).isDirectory()) return; }
	catch (error) {
		warnReapError(root, error);
		return;
	}
	for (const owner of entries(root)) {
		if (!owner.isDirectory()) continue;
		const ownerDir = path.join(root, owner.name);
		for (const run of entries(ownerDir)) {
			if (!run.isDirectory()) continue;
			const directory = path.join(ownerDir, run.name);
			for (const entry of entries(directory)) {
				const match = LAUNCH_FILE.exec(entry.name);
				if (!entry.isFile() || !match) continue;
				const file = path.join(directory, entry.name);
				try {
					const stat = fs.lstatSync(file);
					if (!stat.isFile() || now - stat.mtimeMs < ABANDONED_LAUNCH_AGE_MS
						|| (typeof process.getuid === "function" && stat.uid !== process.getuid())) continue;
					const pid = Number(match[1]);
					if (!Number.isSafeInteger(pid) || pid > 0x7fffffff) continue;
					try { process.kill(pid, 0); }
					catch (error) {
						// EPERM and other ambiguous liveness failures must preserve it.
						if ((error as NodeJS.ErrnoException).code === "ESRCH") fs.unlinkSync(file);
					}
				} catch (error) {
					warnReapError(file, error);
				}
			}
		}
	}
}
