import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { ABANDONED_LAUNCH_AGE_MS, launchScriptContent, launchScriptPath, reapAbandonedLaunchScripts } from "../src/adapters/launch-script.js";
import { captureCanonicalLaunchArgs, captureLaunchArgs } from "./fixtures/launch-script.js";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-launch-script-")); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test("shell launchers preserve long arguments and shell metacharacters verbatim and self-delete", () => {
	const directory = path.join(root, "目录 with 'quotes' and spaces");
	fs.mkdirSync(directory);
	const file = launchScriptPath(directory);
	const unexpected = path.join(root, "should-not-exist");
	const args = ["", "--session", `/saved sessions/${"历史".repeat(300)}/'file'.jsonl`, "--skill", "line one\nline two", `$(touch '${unexpected}')`, "`touch '" + unexpected + "'`", `; touch '${unexpected}'`, "$HOME", "a\\b\"c'd"];
	fs.writeFileSync(file, launchScriptContent(args), { mode: 0o600, flag: "wx" });
	assert.ok(Buffer.byteLength(fs.readFileSync(file, "utf8")) > 1024);
	assert.deepEqual(captureLaunchArgs(file), args);
	assert.equal(fs.existsSync(file), false);
	assert.equal(fs.existsSync(unexpected), false);
});

test("launches arguments longer than the macOS canonical limit through a real canonical PTY", {
	skip: process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0,
}, () => {
	const file = launchScriptPath(root);
	const args = ["--session", `/sessions/${"历史路径 with spaces ".repeat(100)}/saved.jsonl`, "--skill", "a'b\nc"];
	assert.ok(Buffer.byteLength(args.join(" ")) > 1024);
	fs.writeFileSync(file, launchScriptContent(args), { mode: 0o600 });
	const result = captureCanonicalLaunchArgs(file);
	assert.equal(result.canonical, true);
	assert.ok(result.input_bytes < 128);
	assert.deepEqual(result.args, args);
});

test("reaps only old files from dead launcher processes, without deleting channels or other files", () => {
	const run = path.join(root, "main", "run");
	fs.mkdirSync(run, { recursive: true });
	const now = Date.now();
	const old = new Date(now - ABANDONED_LAUNCH_AGE_MS - 1000);
	const suffix = "12345678-abcd-4000-8000-123456789abc.sh";
	const dead = `launch-2147483647-${suffix}`;
	const live = `launch-${process.pid}-${suffix}`;
	const young = "launch-2147483647-22345678-abcd-4000-8000-123456789abc.sh";
	for (const name of [dead, live, young, "launch-not-ours.sh", "manifest.json"]) {
		fs.writeFileSync(path.join(run, name), "fixture", { mode: 0o600 });
		if (name !== young) fs.utimesSync(path.join(run, name), old, old);
	}
	reapAbandonedLaunchScripts(root, now);
	assert.deepEqual(fs.readdirSync(run).sort(), [live, young, "launch-not-ours.sh", "manifest.json"].sort());
	assert.equal(fs.existsSync(run), true);
	reapAbandonedLaunchScripts(root, now); // Idempotent after a prior sweep.
});

for (const [failure, mode] of [["unreadable directory", 0o000], ["unremovable script", 0o500]] as const) {
	test(`continues reaping other channels after an ${failure}`, {
		skip: process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0),
	}, (t) => {
		const blocked = path.join(root, "main", "a-blocked");
		const healthy = path.join(root, "main", "z-healthy");
		const name = "launch-2147483647-12345678-abcd-4000-8000-123456789abc.sh";
		const old = new Date(Date.now() - ABANDONED_LAUNCH_AGE_MS - 1000);
		for (const directory of [blocked, healthy]) {
			fs.mkdirSync(directory, { recursive: true });
			const file = path.join(directory, name);
			fs.writeFileSync(file, "fixture");
			fs.utimesSync(file, old, old);
		}
		const warnings: string[] = [];
		t.mock.method(console, "warn", (message: string) => { warnings.push(message); });
		fs.chmodSync(blocked, mode);
		try {
			assert.doesNotThrow(() => reapAbandonedLaunchScripts(root));
			assert.equal(fs.existsSync(path.join(healthy, name)), false);
			assert.equal(warnings.length, 1);
			assert.ok(warnings[0]!.includes(blocked));
			assert.match(warnings[0]!, /EACCES|EPERM/);
		} finally { fs.chmodSync(blocked, 0o700); }
		assert.equal(fs.readFileSync(path.join(blocked, name), "utf8"), "fixture");
		assert.equal(fs.existsSync(healthy), true, "Channel directories must be preserved");
	});
}

test("does not follow symlinked roots, owners, runs, or launcher files", () => {
	const outside = path.join(root, "outside");
	const runtime = path.join(root, "runtime");
	const run = path.join(runtime, "main", "run");
	fs.mkdirSync(outside);
	fs.mkdirSync(run, { recursive: true });
	const name = "launch-2147483647-12345678-abcd-4000-8000-123456789abc.sh";
	const target = path.join(outside, name);
	fs.writeFileSync(target, "preserve");
	const old = new Date(Date.now() - ABANDONED_LAUNCH_AGE_MS - 1000);
	fs.utimesSync(target, old, old);
	fs.symlinkSync(outside, path.join(runtime, "linked-owner"));
	fs.symlinkSync(outside, path.join(runtime, "main", "linked-run"));
	fs.symlinkSync(target, path.join(run, name));
	fs.symlinkSync(runtime, path.join(root, "linked-root"));
	reapAbandonedLaunchScripts(runtime);
	reapAbandonedLaunchScripts(path.join(root, "linked-root"));
	assert.equal(fs.readFileSync(target, "utf8"), "preserve");
	assert.equal(fs.lstatSync(path.join(run, name)).isSymbolicLink(), true);
});

test("preserves scripts when process liveness is uncertain", (t) => {
	const run = path.join(root, "main", "run");
	fs.mkdirSync(run, { recursive: true });
	const file = path.join(run, "launch-2147483647-12345678-abcd-4000-8000-123456789abc.sh");
	fs.writeFileSync(file, "preserve");
	const old = new Date(Date.now() - ABANDONED_LAUNCH_AGE_MS - 1000);
	fs.utimesSync(file, old, old);
	t.mock.method(process, "kill", () => { throw Object.assign(new Error("Permission denied"), { code: "EPERM" }); });
	reapAbandonedLaunchScripts(root);
	assert.equal(fs.existsSync(file), true);
});

test("missing runtime roots are harmless", () => {
	reapAbandonedLaunchScripts(path.join(root, "missing"));
});
