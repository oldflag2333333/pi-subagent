import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HerdrLaunchCleanupError, HerdrTabAdapter } from "../src/adapters/herdr.js";
import { runtimeRoot } from "../src/channel.js";
import type { SubLaunchSpec } from "../src/types.js";
import { launchPathFromEnv, readyAgent } from "./fixtures/launch-script.js";

let root: string;
let previousWorkspace: string | undefined;
let previousRuntime: string | undefined;
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-herdr-reliable-"));
	previousWorkspace = process.env.HERDR_WORKSPACE_ID;
	previousRuntime = process.env.XDG_RUNTIME_DIR;
	process.env.HERDR_WORKSPACE_ID = "w1";
	process.env.XDG_RUNTIME_DIR = root;
});
afterEach(() => {
	if (previousWorkspace === undefined) delete process.env.HERDR_WORKSPACE_ID;
	else process.env.HERDR_WORKSPACE_ID = previousWorkspace;
	if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
	else process.env.XDG_RUNTIME_DIR = previousRuntime;
	fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const spec: SubLaunchSpec = {
		runId: "12345678-abcd-4000-8000-123456789abc", mainSessionId: "main", title: "Review", task: "Review code", cwd: root,
		projectTrusted: false, sessionId: "sub-session", channelDir: root, token: "token", entryPath: "/tmp/subagent.ts",
		profile: { version: 1, name: "reviewer", tools: ["read"], source: "global", sourcePath: "/tmp/reviewer.json", resolvedSkills: [], resolvedExtensions: [] },
	};
	const calls: string[][] = [];
	let launcher = "";
	const success = (stdout = "{}") => ({ code: 0, killed: false, stdout, stderr: "" });
	let inspect = async () => success(readyAgent("pane", "tab", { terminal_id: "terminal" }));
	let closeFails = false;
	const pi = { exec: async (_command: string, args: string[]) => {
		calls.push(args);
		if (args[1] === "create") {
			launcher = launchPathFromEnv(args);
			return success(JSON.stringify({ tab: { tab_id: "tab" }, root_pane: { pane_id: "pane", terminal_id: "terminal" } }));
		}
		if (args[1] === "get") return inspect();
		if (args[1] === "close" && closeFails) return { code: 1, killed: false, stdout: "", stderr: "Close failed" };
		return success();
	} } as unknown as ExtensionAPI;
	return { spec, calls, adapter: new HerdrTabAdapter(pi), launcher: () => launcher,
		inspect: (callback: typeof inspect) => { inspect = callback; }, closeFails: () => { closeFails = true; }, success };
}

test("an unreadable historical channel does not prevent a new Sub from launching", {
	skip: process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0),
}, async (t) => {
	const f = fixture();
	const stale = path.join(runtimeRoot(), "old-main", "old-run");
	const current = path.join(runtimeRoot(), "new-main", "new-run");
	fs.mkdirSync(stale, { recursive: true });
	fs.mkdirSync(current, { recursive: true });
	const warnings: string[] = [];
	t.mock.method(console, "warn", (message: string) => { warnings.push(message); });
	fs.chmodSync(stale, 0o000);
	try {
		const handle = await f.adapter.launch({ ...f.spec, channelDir: current });
		assert.equal(handle.paneId, "pane");
		assert.equal(f.calls.filter((args) => args[1] === "prompt").length, 1);
		assert.equal(f.calls.some((args) => args[1] === "close"), false);
		assert.equal(fs.existsSync(f.launcher()), false);
		assert.equal(warnings.length, 1);
		assert.ok(warnings[0]!.includes(stale));
	} finally { fs.chmodSync(stale, 0o700); }
});

test("waits through missing, working, and launch-pending agents without replaying the command", async () => {
	const f = fixture();
	let checks = 0;
	f.inspect(async () => {
		checks++;
		assert.equal(f.calls.some((args) => args[1] === "prompt"), false);
		if (checks === 1) return { code: 1, killed: false, stdout: "", stderr: JSON.stringify({ error: { code: "agent_not_found" } }) };
		return f.success(readyAgent("pane", "tab", { terminal_id: "terminal", agent_status: checks === 2 ? "working" : "idle", launch_pending: checks === 3 }));
	});
	await f.adapter.launch(f.spec);
	assert.equal(checks, 4);
	assert.equal(f.calls.filter((args) => args[1] === "run").length, 1);
	assert.equal(f.calls.filter((args) => args[1] === "prompt").length, 1);
	assert.equal(fs.existsSync(f.launcher()), false);
});

for (const [description, response, expected] of [
	["blocked", readyAgent("pane", "tab", { terminal_id: "terminal", agent_status: "blocked" }), /blocked/],
	["wrong kind", readyAgent("pane", "tab", { terminal_id: "terminal", agent: "claude" }), /Expected Sub Pi/],
	["wrong pane", readyAgent("other", "tab", { terminal_id: "terminal" }), /terminal changed/],
	["wrong tab", readyAgent("pane", "other", { terminal_id: "terminal" }), /terminal changed/],
	["replaced terminal", readyAgent("pane", "tab", { terminal_id: "other" }), /terminal changed/],
	["malformed JSON", "not json", /Invalid Herdr/],
	["missing agent", "{}", /did not contain an agent/],
] as const) {
	test(`rejects ${description} during startup and removes its unexecuted script`, async () => {
		const f = fixture();
		f.inspect(async () => f.success(response));
		await assert.rejects(f.adapter.launch(f.spec), expected);
		assert.equal(f.calls.filter((args) => args[1] === "close").length, 1);
		assert.equal(f.calls.some((args) => args[1] === "prompt"), false);
		assert.equal(fs.existsSync(f.launcher()), false);
	});
}

test("does not mask Herdr transport errors as an agent that is still starting", async () => {
	const f = fixture();
	f.inspect(async () => ({ code: 1, killed: false, stdout: "", stderr: JSON.stringify({ error: { code: "server_unavailable" } }) }));
	await assert.rejects(f.adapter.launch(f.spec), /server_unavailable/);
	assert.equal(fs.existsSync(f.launcher()), false);
});

test("cancellation removes an admitted but unopened script even when tab rollback fails", async () => {
	const f = fixture();
	f.closeFails();
	const controller = new AbortController();
	let inspected!: () => void;
	const inspecting = new Promise<void>((resolve) => { inspected = resolve; });
	f.inspect(async () => {
		inspected();
		return f.success(readyAgent("pane", "tab", { terminal_id: "terminal", agent_status: "working" }));
	});
	const launched = f.adapter.launch(f.spec, controller.signal);
	await inspecting;
	assert.equal(fs.existsSync(f.launcher()), true);
	controller.abort(new Error("Cancelled by user"));
	await assert.rejects(launched, (error: unknown) => {
		assert.ok(error instanceof HerdrLaunchCleanupError);
		assert.match(error.message, /Cancelled by user.*Close failed/);
		return true;
	});
	assert.equal(fs.existsSync(f.launcher()), false);
	assert.equal(f.calls.some((args) => args[1] === "prompt"), false);
});

test("the startup deadline also covers a late idle response and cleans up the script", async (t) => {
	const f = fixture();
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	f.inspect(async () => {
		now += 60_001;
		return f.success(readyAgent("pane", "tab", { terminal_id: "terminal" }));
	});
	await assert.rejects(f.adapter.launch(f.spec), /within 60 seconds/);
	assert.equal(fs.existsSync(f.launcher()), false);
	assert.equal(f.calls.some((args) => args[1] === "prompt"), false);
});

test("script removal failures are surfaced and roll back the tab instead of claiming success", {
	skip: process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0),
}, async () => {
	const f = fixture();
	f.inspect(async () => {
		fs.chmodSync(root, 0o500);
		return f.success(readyAgent("pane", "tab", { terminal_id: "terminal" }));
	});
	try {
		await assert.rejects(f.adapter.launch(f.spec), /Launch script cleanup also failed/);
		assert.equal(f.calls.filter((args) => args[1] === "close").length, 1);
		assert.equal(f.calls.some((args) => args[1] === "prompt"), false);
		assert.equal(fs.existsSync(f.launcher()), true, "An unlink failure must not be hidden");
	} finally { fs.chmodSync(root, 0o700); }
});

test("script creation failure rolls back the tab and never queues an invocation", async () => {
	const f = fixture();
	await assert.rejects(f.adapter.launch({ ...f.spec, channelDir: path.join(root, "missing") }), /ENOENT/);
	assert.equal(f.calls.some((args) => args[1] === "run"), false);
	assert.equal(f.calls.filter((args) => args[1] === "close").length, 1);
});
