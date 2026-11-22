import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HerdrCoreAdapter, coreLaunchCommand } from "../src/adapters/herdr-core.js";
import { execFileSync } from "node:child_process";
import { AdapterRegistry } from "../src/adapters/index.js";
import { HerdrLaunchCleanupError } from "../src/adapters/herdr.js";
import type { SubLaunchSpec } from "../src/types.js";

const handle = { adapter: "herdr" as const, backend: "core" as const, terminalId: "sub" };
const layout = { spaces: [{ id: "space", tabs: [{ id: "main-tab", terminals: [{ terminal: "main" }] }, { id: "tab", terminals: [{ terminal: "sub" }] }] }] };
const ready = { address: "sub", state: "live", status: { app: "pi", state: "idle" } };
const reply = (data: unknown, code = 0) => ({ stdout: JSON.stringify(data), stderr: "", code, killed: false });

test("terminal launch command quotes paths safely and rejects overlong input", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-shell-"));
	const launcher = path.join(home, "launch 'quoted'.sh");
	try {
		fs.writeFileSync(path.join(home, ".zshenv"), "export HTTP_PROXY=http://127.0.0.1:1234\nexport HTTPS_PROXY=$HTTP_PROXY\nexport http_proxy=$HTTP_PROXY\nexport https_proxy=$HTTPS_PROXY\nexport NO_PROXY=localhost,127.0.0.1,.internal\nexport no_proxy=$NO_PROXY\n");
		fs.writeFileSync(launcher, 'printf "%s\\n" "$HTTP_PROXY" "$HTTPS_PROXY" "$http_proxy" "$https_proxy" "$NO_PROXY" "$no_proxy" "$HC_TERMINAL_ID"\n');
		const output = execFileSync("/bin/sh", ["-c", coreLaunchCommand(launcher)], { encoding: "utf8", env: {
			HOME: home, PATH: "/usr/bin:/bin", HC_TERMINAL_ID: "child-terminal",
			HTTP_PROXY: "http://127.0.0.1:1234", HTTPS_PROXY: "http://127.0.0.1:1234",
			http_proxy: "http://127.0.0.1:1234", https_proxy: "http://127.0.0.1:1234",
			NO_PROXY: "localhost,127.0.0.1,.internal", no_proxy: "localhost,127.0.0.1,.internal",
		}, stdio: ["ignore", "pipe", "pipe"] });
		assert.deepEqual(output.trim().split("\n"), [
			...Array(4).fill("http://127.0.0.1:1234"), "localhost,127.0.0.1,.internal", "localhost,127.0.0.1,.internal", "child-terminal",
		]);
		assert.throws(() => coreLaunchCommand("/tmp/" + "长".repeat(400)), /too long/);
	} finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("core launch binds Main without a tab, suppresses duplicate notes, keeps private env and waits before send", async () => {
	const previous = process.env.HC_TERMINAL_ID;
	process.env.HC_TERMINAL_ID = "main";
	const channelDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-core-"));
	const calls: string[][] = [];
	const spec = { runId: "run", mainSessionId: "main-session", title: "中文 title", task: "Task", cwd: "/tmp", projectTrusted: true,
		sessionId: "sub-session", channelDir, token: "secret'值", entryPath: "/tmp/entry.ts",
		profile: { name: "test", sessionPersistence: "ephemeral", tools: [], resolvedSkills: [], resolvedExtensions: [] } } as unknown as SubLaunchSpec;
	const pi = { exec: async (binary: string, args: string[]) => {
		calls.push([binary, ...args]);
		if (args[0] === "ls") return reply(layout);
		assert.equal(binary, "herdr-core");
		if (args[0] === "run") {
			assert.equal(args[args.indexOf("--parent") + 1], "main");
			assert.ok(args.includes("--no-notify")); assert.ok(args.includes("--outlive-parent"));
			assert.equal(args[args.indexOf("--cwd") + 1], spec.cwd);
			const file = path.join(channelDir, fs.readdirSync(channelDir)[0]!);
			assert.equal(args.includes("--"), false, "Core must start its normal configured shell, not explicit argv");
			assert.equal(args.includes("-lic"), false);
			assert.equal(fs.statSync(file).mode & 0o777, 0o600);
			const script = fs.readFileSync(file, "utf8");
			assert.match(script, /PI_SUBAGENT_ROLE='sub'/);
			assert.equal(script.includes("export PATH="), false, "Do not overwrite the initialized shell PATH");
			assert.match(script, /--no-session/); assert.match(script, /--no-extensions/);
			assert.equal(args.join().includes(spec.token), false);
			return reply({ address: "sub" });
		}
		if (args[0] === "get") return reply(ready);
		return reply({});
	} } as unknown as ExtensionAPI;
	try {
		const adapter = new HerdrCoreAdapter(pi);
		assert.deepEqual(await adapter.launch(spec), handle);
		assert.deepEqual(fs.readdirSync(channelDir), []);
		const sends = calls.filter(c => c[1] === "send");
		assert.equal(sends.length, 2);
		assert.match(sends[0]![3]!, /^exec sh /);
		assert.ok(calls.indexOf(sends[0]!) < calls.findIndex(c => c[1] === "wait"));
		assert.ok(calls.findIndex(c => c[1] === "wait") < calls.indexOf(sends[1]!));
		assert.deepEqual(calls.at(-1), ["herdr-core", "send", "sub", "Task"]);
		assert.ok(await new AdapterRegistry(pi).resolve() instanceof HerdrCoreAdapter);
	} finally {
		if (previous === undefined) delete process.env.HC_TERMINAL_ID; else process.env.HC_TERMINAL_ID = previous;
		fs.rmSync(channelDir, { recursive: true, force: true });
	}
});

test("core status and existence distinguish done, closure and outages; saved handles route independently of env", async () => {
	for (const [data, code, status, exists] of [
		[ready, 0, "idle", true],
		[{ ...ready, status: { app: "pi", state: "done" } }, 0, "idle", true],
		[{ ...ready, status: { app: "pi", state: "working" } }, 0, "working", true],
		[{ ...ready, state: "finished" }, 0, "unknown", false],
		[{ error: { kind: "not_found" } }, 1, "unknown", false],
		[{ error: { kind: "unavailable" } }, 1, "unknown", undefined],
		[{ ...ready, address: "other" }, 0, "unknown", undefined],
	] as const) {
		const pi = { exec: async (binary: string) => { assert.equal(binary, "herdr-core"); return reply(data, code); } } as unknown as ExtensionAPI;
		const registry = new AdapterRegistry(pi);
		assert.equal(await registry.status(handle), status);
		assert.equal(await registry.exists(handle), exists);
	}
});

test("core launch failures roll back without the cancelled signal and retain failed cleanup handles", async () => {
	const previous = process.env.HC_TERMINAL_ID;
	process.env.HC_TERMINAL_ID = "main";
	const channelDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-core-"));
	const spec = { runId: "run", mainSessionId: "main", title: "test", task: "Task", cwd: "/tmp", projectTrusted: false,
		sessionId: "id", channelDir, token: "token", entryPath: "/tmp/entry.ts",
		profile: { name: "test", sessionPersistence: "ephemeral", tools: [], resolvedSkills: [], resolvedExtensions: [] } } as unknown as SubLaunchSpec;
	try {
		for (const cleanupFails of [false, true]) {
			const controller = new AbortController();
			const calls: string[] = [];
			const pi = { exec: async (_binary: string, args: string[], options: { signal?: AbortSignal }) => {
				calls.push(args[0]!);
				if (args[0] === "ls") return reply(layout);
				if (args[0] === "run") { controller.abort(); return reply({ address: "sub" }); }
				assert.equal(options.signal, undefined);
				if (args[0] === "get") return reply(ready);
				if (cleanupFails) throw new Error("cleanup failed");
				return reply({});
			} } as unknown as ExtensionAPI;
			await assert.rejects(new HerdrCoreAdapter(pi).launch(spec, controller.signal), error => {
				if (cleanupFails) { assert.ok(error instanceof HerdrLaunchCleanupError); assert.deepEqual(error.handle, handle); }
				return true;
			});
			assert.ok(calls.includes("kill")); assert.ok(!calls.includes("send"));
			assert.deepEqual(fs.readdirSync(channelDir), []);
		}
	} finally {
		if (previous === undefined) delete process.env.HC_TERMINAL_ID; else process.env.HC_TERMINAL_ID = previous;
		fs.rmSync(channelDir, { recursive: true, force: true });
	}
});
