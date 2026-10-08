import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createChannel, listTalkToMain, readManifest, talkToMain, writeSubClosed } from "../src/channel.js";
import { MainRunManager, RUN_ENTRY } from "../src/run-manager.js";
import type { RunSnapshot } from "../src/types.js";

let root: string;
let previous: Record<string, string | undefined>;
const managers: MainRunManager[] = [];
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "facets-manager-reliable-"));
	previous = Object.fromEntries(["XDG_RUNTIME_DIR", "HERDR_ENV", "HERDR_WORKSPACE_ID"].map((key) => [key, process.env[key]]));
	process.env.XDG_RUNTIME_DIR = root;
	process.env.HERDR_ENV = "1";
	process.env.HERDR_WORKSPACE_ID = "w1";
});
afterEach(() => {
	for (const manager of managers.splice(0)) manager.shutdown();
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
	fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const session = SessionManager.inMemory(root, { id: "main-session" });
	const messages: any[] = [];
	const queued: any[] = [];
	const warnings: string[] = [];
	let idle = true;
	const pi = {
		on: () => () => {},
		appendEntry: (type: string, data: unknown) => session.appendCustomEntry(type, data),
		sendUserMessage: (message: any) => {
			messages.push(message);
			if (idle) session.appendMessage({ role: "user", content: message, timestamp: Date.now() });
			else queued.push(message);
		},
		exec: async (_command: string, args: string[]) => ({ code: 0, killed: false, stderr: "", stdout: args[1] === "create" ? JSON.stringify({ tab: { tab_id: "tab" }, root_pane: { pane_id: "pane" } }) : "{}" }),
	} as unknown as ExtensionAPI;
	const ctx = { model: {}, signal: new AbortController().signal, cwd: root, sessionManager: session, isIdle: () => idle, hasPendingMessages: () => false, isProjectTrusted: () => true, hasUI: true,
		ui: { notify: (message: string) => warnings.push(message) },
	} as unknown as ExtensionContext;
	const manager = new MainRunManager(pi);
	managers.push(manager);
	const profile = { version: 1 as const, name: "reviewer", tools: ["read"], source: "global" as const, sourcePath: "/tmp/reviewer.json", resolvedSkills: [], resolvedExtensions: [] };
	const open = (runId = "run") => {
		const channel = createChannel({ runId, mainSessionId: "main-session", title: runId, task: "Review", cwd: root, profile });
		const run: RunSnapshot = { version: 1, runId, mainSessionId: "main-session", title: runId, cwd: root, profileName: "reviewer", sessionPersistence: "ephemeral", channelDir: channel.channelDir,
			createdAt: Date.now(), updatedAt: Date.now(), surface: { adapter: "herdr", tabId: `tab-${runId}`, paneId: `pane-${runId}` },
		};
		manager.runs.set(runId, run);
		session.appendCustomEntry(RUN_ENTRY, { ...run });
		return { run, manifest: readManifest(run.channelDir) };
	};
	return { pi, ctx, manager, profile, session, messages, warnings, open,
		idle: (value: boolean) => { idle = value; },
		receiveNext: () => { const message = queued.shift(); if (message) session.appendMessage({ role: "user", content: message, timestamp: Date.now() }); },
	};
}

test("retains final messages after manual closure until the busy Main receives them in order", () => {
	const f = fixture();
	const { run, manifest } = f.open();
	talkToMain(run.channelDir, manifest, "First final message");
	talkToMain(run.channelDir, manifest, "Second final message");
	writeSubClosed(run.channelDir, manifest, "Manual close");
	f.idle(false);
	f.manager.start(f.ctx);
	assert.equal(f.manager.runs.size, 0);
	assert.ok(fs.existsSync(run.channelDir));
	assert.equal(f.messages.length, 2, "Both messages enter Pi\'s queue while Main is busy");
	f.receiveNext();
	f.manager.start(f.ctx);
	assert.ok(f.messages[0].includes("First final message"));
	assert.match(f.messages[0], /already closed/);
	assert.ok(fs.existsSync(run.channelDir));
	f.receiveNext();
	f.manager.start(f.ctx);
	assert.ok(f.messages[1].includes("Second final message"));
	f.manager.start(f.ctx);
	assert.equal(fs.existsSync(run.channelDir), false);
	assert.equal(f.messages.length, 2);
});

test("does not remove an asynchronously submitted delivery before it appears in the session", () => {
	const f = fixture();
	const { run, manifest } = f.open();
	talkToMain(run.channelDir, manifest, "Delayed receipt");
	let submitted: any;
	let count = 0;
	f.pi.sendUserMessage = (message) => { submitted = message; count++; f.idle(false); };
	f.manager.start(f.ctx);
	assert.equal(listTalkToMain(run.channelDir, manifest).length, 1);
	f.manager.start(f.ctx);
	assert.equal(count, 1);
	f.session.appendMessage({ role: "user", content: submitted, timestamp: Date.now() });
	f.manager.start(f.ctx);
	assert.deepEqual(listTalkToMain(run.channelDir, manifest), []);
	assert.equal(count, 1);
});

test("a failed delivery remains retryable without being marked as seen", () => {
	const f = fixture();
	const { run, manifest } = f.open();
	talkToMain(run.channelDir, manifest, "Retry me");
	const send = f.pi.sendUserMessage;
	f.pi.sendUserMessage = () => { throw new Error("Cannot submit"); };
	f.manager.start(f.ctx);
	assert.equal(listTalkToMain(run.channelDir, manifest).length, 1);
	assert.equal(f.warnings.length, 1);
	f.pi.sendUserMessage = send;
	f.manager.start(f.ctx);
	assert.deepEqual(listTalkToMain(run.channelDir, manifest), []);
	assert.equal(f.messages.length, 1);
});

test("a corrupt channel is reported once without blocking another Sub", () => {
	const f = fixture();
	const broken = f.open("broken");
	const healthy = f.open("healthy");
	fs.writeFileSync(path.join(broken.run.channelDir, "to-main", "bad.json"), "{broken");
	talkToMain(healthy.run.channelDir, healthy.manifest, "Healthy delivery");
	f.manager.start(f.ctx);
	assert.equal(f.warnings.length, 1);
	assert.ok(f.messages[0].includes("Healthy delivery"));
	f.manager.start(f.ctx);
	assert.equal(f.warnings.length, 1);
	fs.rmSync(path.join(broken.run.channelDir, "to-main", "bad.json"));
	talkToMain(broken.run.channelDir, broken.manifest, "Recovered");
	f.manager.start(f.ctx);
	assert.ok(f.messages[1].includes("Recovered"));
});

test("a failed Herdr close retains the run and channel for retry", async () => {
	const f = fixture();
	const { run } = f.open();
	const exec = f.pi.exec;
	f.pi.exec = async () => ({ code: 1, killed: false, stdout: "", stderr: "Close failed" });
	await assert.rejects(() => f.manager.close(run.runId, "Done"), /Close failed/);
	assert.equal(f.manager.runs.get(run.runId), run);
	assert.equal(run.closedAt, undefined);
	assert.ok(fs.existsSync(run.channelDir));
	f.pi.exec = exec;
	await f.manager.close(run.runId, "Retry");
	assert.equal(f.manager.runs.has(run.runId), false);
	assert.equal(fs.existsSync(run.channelDir), false);
});

test("explicit close retains final deliveries and restores their drain state after reload", async () => {
	const f = fixture();
	const { run, manifest } = f.open();
	talkToMain(run.channelDir, manifest, "Final result");
	await f.manager.close(run.runId, "Done");
	assert.equal(f.manager.runs.has(run.runId), false);
	assert.ok(run.closedAt);
	assert.ok(fs.existsSync(run.channelDir));
	assert.equal(f.messages.length, 0);
	const restored = new MainRunManager(f.pi);
	managers.push(restored);
	f.idle(false);
	restored.start(f.ctx);
	assert.equal(restored.runs.size, 0);
	assert.ok(fs.existsSync(run.channelDir));
	f.idle(true);
	f.receiveNext();
	restored.start(f.ctx);
	assert.equal(f.messages.length, 1);
	restored.start(f.ctx);
	assert.equal(fs.existsSync(run.channelDir), false);
});

test("launch rollback failure remains addressable through close_sub", async () => {
	const f = fixture();
	f.manager.start(f.ctx);
	const exec = f.pi.exec;
	let closeFailed = true;
	f.pi.exec = async (command, args, options) => {
		if (args[1] === "start") throw new Error("Launch failed");
		if (args[1] === "close" && closeFailed) return { code: 1, killed: false, stdout: "", stderr: "Close failed" };
		return exec(command, args, options);
	};
	await assert.rejects(() => f.manager.delegate({ title: "Review", task: "Review", cwd: root, profile: f.profile }), /Use close_sub to retry/);
	const run = [...f.manager.runs.values()][0]!;
	assert.equal(run.surface?.tabId, "tab");
	assert.ok(fs.existsSync(run.channelDir));
	closeFailed = false;
	await f.manager.close(run.runId, "Retry cleanup");
	assert.equal(f.manager.runs.size, 0);
	assert.equal(fs.existsSync(run.channelDir), false);
});

test("startup failure still retains queued Sub diagnostics after successful rollback", async () => {
	const f = fixture();
	f.idle(false);
	f.manager.start(f.ctx);
	const exec = f.pi.exec;
	let failedRun: RunSnapshot | undefined;
	f.pi.exec = async (command, args, options) => {
		if (args[1] === "report-metadata") {
			failedRun = [...f.manager.runs.values()][0]!;
			talkToMain(failedRun.channelDir, readManifest(failedRun.channelDir), "Startup diagnostics");
			return { code: 1, killed: false, stdout: "", stderr: "Metadata failed" };
		}
		return exec(command, args, options);
	};
	await assert.rejects(() => f.manager.delegate({ title: "Review", task: "Review", cwd: root, profile: f.profile }), /Metadata failed/);
	assert.equal(f.manager.runs.size, 0);
	assert.ok(failedRun?.closedAt);
	assert.ok(fs.existsSync(failedRun!.channelDir));
	f.manager.start(f.ctx);
	f.receiveNext();
	f.idle(true);
	f.manager.start(f.ctx);
	assert.ok(f.messages[0].includes("Startup diagnostics"));
	f.manager.start(f.ctx);
	assert.equal(fs.existsSync(failedRun!.channelDir), false);
});

test("initial state persistence failure does not leave a channel or consume a Sub slot", async () => {
	const f = fixture();
	f.manager.start(f.ctx);
	let channelDir = "";
	let commands = 0;
	f.pi.appendEntry = (_type, data) => { channelDir = (data as RunSnapshot).channelDir; throw new Error("Storage failed"); };
	f.pi.exec = async () => { commands++; throw new Error("Must not launch"); };
	await assert.rejects(() => f.manager.delegate({ title: "Review", task: "Review", cwd: root, profile: f.profile }), /Storage failed/);
	assert.equal(commands, 0);
	assert.equal(f.manager.runs.size, 0);
	assert.equal(fs.existsSync(channelDir), false);
});

test("surface closure succeeds even if the retained inbox is corrupt", async () => {
	const f = fixture();
	const { run } = f.open();
	fs.writeFileSync(path.join(run.channelDir, "to-main", "bad.json"), "{broken");
	f.manager.start(f.ctx);
	await f.manager.close(run.runId, "Done");
	assert.equal(f.manager.runs.size, 0);
	assert.ok(fs.existsSync(run.channelDir));
	fs.rmSync(path.join(run.channelDir, "to-main", "bad.json"));
	f.manager.start(f.ctx);
	assert.equal(fs.existsSync(run.channelDir), false);
});

test("channel closure markers survive a failed close-state snapshot write", async () => {
	const f = fixture();
	const { run, manifest } = f.open();
	talkToMain(run.channelDir, manifest, "Retained result");
	f.idle(false);
	f.manager.start(f.ctx);
	const append = f.pi.appendEntry;
	f.pi.appendEntry = () => { throw new Error("Storage failed"); };
	await assert.rejects(() => f.manager.close(run.runId, "Done"), /Storage failed/);
	assert.equal(f.manager.runs.size, 0);
	f.manager.shutdown();
	f.pi.appendEntry = append;
	const restored = new MainRunManager(f.pi);
	managers.push(restored);
	f.idle(true);
	f.receiveNext();
	restored.start(f.ctx);
	assert.equal(restored.runs.size, 0);
	assert.ok(f.messages[0].includes("Retained result"));
	restored.start(f.ctx);
	assert.equal(fs.existsSync(run.channelDir), false);
});

test("a failure after successful launch also closes the tab instead of orphaning it", async () => {
	const f = fixture();
	f.manager.start(f.ctx);
	const exec = f.pi.exec;
	let closed = 0;
	f.pi.exec = async (command, args, options) => {
		if (args[1] === "prompt") {
			const run = [...f.manager.runs.values()][0]!;
			fs.writeFileSync(path.join(run.channelDir, "session.json"), "{broken");
		}
		if (args[1] === "close") closed++;
		return exec(command, args, options);
	};
	await assert.rejects(() => f.manager.delegate({ title: "Review", task: "Review", cwd: root, profile: f.profile }));
	assert.equal(closed, 1);
	assert.equal(f.manager.runs.size, 0);
});
