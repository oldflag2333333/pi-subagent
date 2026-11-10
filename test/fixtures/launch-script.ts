import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";

const bin = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-fake-pi-"));
fs.writeFileSync(path.join(bin, "pi"), `#!/usr/bin/env node\nif (process.env.PI_SUBAGENT_LAUNCH !== undefined) throw new Error("Launcher env leaked into Pi");\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
after(() => fs.rmSync(bin, { recursive: true, force: true }));

/** Execute the real shell launcher, substituting only Pi itself. */
export function captureLaunchArgs(launcher: string): string[] {
	const result = spawnSync("sh", [launcher], {
		encoding: "utf8",
		env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, PI_SUBAGENT_LAUNCH: launcher },
	});
	assert.equal(result.status, 0, result.stderr || String(result.error));
	assert.equal(fs.existsSync(launcher), false, "The opened launcher must unlink itself");
	return JSON.parse(result.stdout) as string[];
}

export function captureCanonicalLaunchArgs(launcher: string): { canonical: boolean; input_bytes: number; args: string[] } {
	const result = spawnSync("python3", [fileURLToPath(new URL("./canonical-launch.py", import.meta.url))], {
		encoding: "utf8", timeout: 12_000,
		env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, PI_SUBAGENT_LAUNCH: launcher },
	});
	assert.equal(result.status, 0, result.stderr || String(result.error));
	assert.equal(fs.existsSync(launcher), false);
	return JSON.parse(result.stdout);
}

export function launchPathFromEnv(args: string[]): string {
	return args.find((arg) => arg.startsWith("PI_SUBAGENT_LAUNCH="))!.slice("PI_SUBAGENT_LAUNCH=".length);
}

export function readyAgent(paneId = "pane", tabId = "tab", extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ agent: { agent: "pi", pane_id: paneId, tab_id: tabId, agent_status: "idle", ...extra } });
}
