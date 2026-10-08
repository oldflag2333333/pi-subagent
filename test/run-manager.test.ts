import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createChannel, listTalkToSub, listTalkToMain, readInterrupt, readManifest, talkToMain, writeActiveTurn, writeSubSessionInfo, writeSubClosed } from "../src/channel.js";
import { MainRunManager } from "../src/run-manager.js";
import type { RunSnapshot } from "../src/types.js";
import { readTalkReceipt } from "../src/talk-message.js";

let root: string;
let previousRuntimeDir: string | undefined;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-facets-manager-"));
	previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
	process.env.XDG_RUNTIME_DIR = root;
});

afterEach(() => {
	if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
	else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
	fs.rmSync(root, { recursive: true, force: true });
});

function openRun(manager: MainRunManager, runId = "open-run"): RunSnapshot {
	const profile = {
		version: 1 as const,
		name: "reviewer",
		tools: ["read"],
		sessionPersistence: "persistent" as const,
		source: "global" as const,
		sourcePath: "/tmp/reviewer.json",
		resolvedSkills: [],
		resolvedExtensions: [],
	};
	const channel = createChannel({
		runId,
		mainSessionId: "main-session",
		title: "Review MR",
		task: "Review it.",
		cwd: "/tmp/project",
		profile,
	});
	const run: RunSnapshot = {
		version: 1,
		runId: channel.runId,
		mainSessionId: channel.mainSessionId,
		title: channel.title,
		cwd: channel.cwd,
		profileName: profile.name,
		sessionPersistence: "persistent",
		channelDir: channel.channelDir,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		surface: { adapter: "herdr", tabId: "w1:t2", paneId: "w1:p2" },
	};
	manager.runs.set(run.runId, run);
	return run;
}

test("defaults to active or persistent Subs and can include all open Subs", async () => {
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir);
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const pi = { exec: async (_command: string, args: string[]) => {
		const paneId = args[2];
		const status = paneId === "w1:p3" ? "working" : paneId === "w1:p4" ? "blocked" : "idle";
		return { code: 0, stdout: JSON.stringify({ result: { agent: { pane_id: paneId, tab_id: `w1:t${paneId?.slice(-1)}`, agent_status: status } } }), stderr: "" };
	} } as unknown as ExtensionAPI;
	try {
		const manager = new MainRunManager(pi);
		const persistent = openRun(manager);
		for (const [runId, paneId] of [["busy", "w1:p3"], ["blocked", "w1:p4"], ["idle", "w1:p5"]]) {
			manager.runs.set(runId, { ...persistent, runId, sessionPersistence: "ephemeral", surface: { adapter: "herdr", paneId, tabId: `w1:t${paneId.slice(-1)}` } });
		}
		manager.runs.set("unknown", { ...persistent, runId: "unknown", sessionPersistence: "ephemeral", surface: undefined });
		const defaults = await manager.subs();
		assert.deepEqual(defaults.open.map(({ run, status }) => [run.runId, status]), [
			["open-run", "idle"], ["busy", "working"], ["blocked", "blocked"],
		]);
		const all = await manager.subs(true);
		assert.deepEqual(all.open.map(({ run, status }) => [run.runId, status]), [
			["open-run", "idle"], ["busy", "working"], ["blocked", "blocked"], ["idle", "idle"], ["unknown", "unknown"],
		]);
	} finally {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
	}
});

test("requests interruption only for a current turn and keeps the Sub open", () => {
	const manager = new MainRunManager({} as ExtensionAPI);
	const run = openRun(manager);
	assert.throws(() => manager.interrupt(run.runId), /no active turn/);
	const manifest = readManifest(run.channelDir);
	const turn = writeActiveTurn(run.channelDir, manifest);
	assert.equal(manager.interrupt(run.runId.slice(0, 4)), run);
	assert.equal(readInterrupt(run.channelDir, manifest)?.turnId, turn.turnId);
	assert.equal(manager.runs.get(run.runId), run);
	assert.equal(fs.existsSync(run.channelDir), true);
	manager.runs.set("open-other", { ...run, runId: "open-other" });
	assert.throws(() => manager.interrupt("open-"), /Ambiguous Sub prefix/);
});

test("talks to and explicitly closes an open Sub without triggering a Main turn", async () => {
	const calls: string[][] = [];
	const messages: unknown[] = [];
	const pi = {
		appendEntry: () => {},
		sendUserMessage: (message: unknown) => messages.push(message),
		exec: async (_command: string, args: string[]) => {
			calls.push(args);
			return { code: 0, stdout: "{}", stderr: "", killed: false };
		},
	} as unknown as ExtensionAPI;
	const manager = new MainRunManager(pi);
	const run = openRun(manager);

	const sent = manager.talk(run.runId, "Please inspect the latest commit.");
	assert.equal(sent.run, run);
	assert.equal(manager.titleFor(run.runId.slice(0, 4)), "Review MR");
	assert.equal(listTalkToSub(run.channelDir, readManifest(run.channelDir))[0]?.message, "Please inspect the latest commit.");

	await manager.close(run.runId, "Accepted");
	assert.equal(manager.runs.has(run.runId), false);
	assert.equal(manager.titleFor(run.runId), "Review MR");
	assert.equal(fs.existsSync(run.channelDir), false);
	assert.deepEqual(calls.at(-1), ["tab", "close", "w1:t2"]);
	assert.deepEqual(messages, []);
});

test("queues a Sub message while Main is busy and acknowledges its receipt without duplicate submission", () => {
	const receipts = SessionManager.inMemory();
	let idle = false;
	const messages: Array<{ message: unknown; options: unknown }> = [];
	const pi = {
		on: () => () => {},
		appendEntry: () => {},
		sendUserMessage: (message: any, options: unknown) => {
			messages.push({ message, options });
			if (idle) receipts.appendMessage({ role: "user", content: message, timestamp: Date.now() });
		},
	} as unknown as ExtensionAPI;
	const manager = new MainRunManager(pi);
	const run = openRun(manager);
	const manifest = readManifest(run.channelDir);
	writeSubSessionInfo(run.channelDir, manifest, { sessionId: "sub-session", sessionFile: "/tmp/sub.jsonl" });
	const sent = talkToMain(run.channelDir, manifest, "Review complete.");

	const ctx = {
		model: {},
		signal: new AbortController().signal,
		isIdle: () => idle,
		hasPendingMessages: () => false,
		sessionManager: receipts,
		hasUI: true,
		ui: { notify: () => {} },
	} as unknown as ExtensionContext;
	manager.start(ctx);
	assert.equal(messages.length, 1);
	const queued = messages[0]!.message as any;
	idle = true;
	receipts.appendMessage({ role: "user", content: queued, timestamp: Date.now() });
	manager.start(ctx);
	manager.shutdown();

	assert.equal(run.subSessionId, "sub-session");
	assert.equal(run.subSessionFile, "/tmp/sub.jsonl");
	assert.equal(messages.length, 1);
	const notification = messages[0];
	assert.ok(notification);
	assert.deepEqual(notification.options, { deliverAs: "followUp", expandPromptTemplates: false });
	const delivered = notification.message as string;
	assert.match(delivered, /Review complete\./);
	assert.deepEqual(readTalkReceipt({ role: "user", content: delivered }), { direction: "to-main", runId: run.runId, messageId: sent.id });
	assert.deepEqual(listTalkToMain(run.channelDir, readManifest(run.channelDir)), []);
});
