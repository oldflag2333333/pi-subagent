import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createChannel, listTalkToMain, MESSAGE_TYPE, readManifest, talkToMain } from "../src/channel.js";
import { deliverTalk, ProtocolErrors } from "../src/talk-delivery.js";
import { formatTalkInput } from "../src/talk-message.js";

let root: string;
let previous: string | undefined;
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "facets-delivery-"));
	previous = process.env.XDG_RUNTIME_DIR;
	process.env.XDG_RUNTIME_DIR = root;
});
afterEach(() => {
	if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
	else process.env.XDG_RUNTIME_DIR = previous;
	fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const channel = createChannel({ runId: "run", mainSessionId: "main", title: "Review", task: "Review", cwd: root,
		profile: { version: 1, name: "reviewer", tools: ["read"], source: "global", sourcePath: "/tmp/profile.json", resolvedSkills: [], resolvedExtensions: [] },
	});
	const manifest = readManifest(channel.channelDir);
	const message = talkToMain(channel.channelDir, manifest, "Final delivery");
	const session = SessionManager.inMemory(root);
	let idle = true;
	let queued = false;
	const warnings: string[] = [];
	const sent: any[] = [];
	const pi = { sendUserMessage: (message: any) => { sent.push(message); } } as unknown as ExtensionAPI;
	const ctx = { model: {}, signal: new AbortController().signal, sessionManager: session, isIdle: () => idle, hasPendingMessages: () => queued, hasUI: true,
		ui: { notify: (message: string) => warnings.push(message) },
	} as unknown as ExtensionContext;
	const send = () => deliverTalk(pi, ctx, channel.channelDir, manifest, "to-main", message, "Delivery content");
	return { channel, manifest, message, session, pi, ctx, warnings, sent, send, busy: () => { idle = false; }, queue: () => { queued = true; } };
}

test("retains the file until a session receipt exists, then acknowledges even while busy", () => {
	const f = fixture();
	assert.equal(f.send(), "sent");
	assert.equal(listTalkToMain(f.channel.channelDir, f.manifest).length, 1);
	f.busy();
	assert.equal(f.send(), "waiting");
	const accepted = f.sent[0];
	f.session.appendMessage({ role: "user", content: accepted, timestamp: Date.now() });
	assert.equal(f.send(), "acknowledged");
	assert.deepEqual(listTalkToMain(f.channel.channelDir, f.manifest), []);
	assert.equal(f.sent.length, 1);
});

test("keeps failed synchronous deliveries retryable and supports synchronous receipts", () => {
	const f = fixture();
	f.pi.sendUserMessage = () => { throw new Error("Delivery failed"); };
	assert.throws(f.send, /Delivery failed/);
	assert.equal(listTalkToMain(f.channel.channelDir, f.manifest).length, 1);
	f.pi.sendUserMessage = (message) => { f.session.appendMessage({ role: "user", content: message, timestamp: Date.now() }); };
	assert.equal(f.send(), "sent");
	assert.deepEqual(listTalkToMain(f.channel.channelDir, f.manifest), []);
});

test("native user-message receipts prevent duplicate delivery in a restored session", () => {
	const f = fixture();
	const content = formatTalkInput({ direction: "to-main", runId: f.manifest.runId, messageId: f.message.id }, "Already received");
	f.session.appendMessage({ role: "user", content: [{ type: "text", text: content }], timestamp: Date.now() });
	const restored = SessionManager.inMemory(root, undefined, f.session.getEntries());
	assert.equal(deliverTalk(f.pi, { ...f.ctx, sessionManager: restored }, f.channel.channelDir, f.manifest, "to-main", f.message, "Delivery"), "acknowledged");
	assert.deepEqual(f.sent, []);
});

test("native receipts must match direction, run, and message ID", () => {
	const f = fixture();
	const receipt = { direction: "to-main" as const, runId: f.manifest.runId, messageId: f.message.id };
	for (const wrong of [{ ...receipt, direction: "to-sub" as const }, { ...receipt, runId: "different" }, { ...receipt, messageId: "different" }]) {
		f.session.appendMessage({ role: "user", content: formatTalkInput(wrong, "Unrelated"), timestamp: Date.now() });
	}
	assert.equal(f.send(), "sent");
	assert.equal(listTalkToMain(f.channel.channelDir, f.manifest).length, 1);
});

test("legacy custom-message receipts prevent duplicate delivery after upgrade", () => {
	const f = fixture();
	f.session.appendCustomMessageEntry(MESSAGE_TYPE, "Already received", true, { direction: "to-main", runId: f.manifest.runId, messageId: f.message.id });
	const restored = SessionManager.inMemory(root, undefined, f.session.getEntries());
	const ctx = { ...f.ctx, sessionManager: restored };
	assert.equal(deliverTalk(f.pi, ctx, f.channel.channelDir, f.manifest, "to-main", f.message, "Delivery"), "acknowledged");
	assert.deepEqual(f.sent, []);
});

test("does not accept receipts for a different direction or run", () => {
	const f = fixture();
	f.session.appendCustomMessageEntry(MESSAGE_TYPE, "Unrelated", true, { direction: "to-sub", runId: f.manifest.runId, messageId: f.message.id });
	f.session.appendCustomMessageEntry(MESSAGE_TYPE, "Unrelated", true, { direction: "to-main", runId: "different", messageId: f.message.id });
	assert.equal(f.send(), "sent");
	assert.equal(listTalkToMain(f.channel.channelDir, f.manifest).length, 1);
});

test("keeps deliveries queued when the receiving Pi has no selected model", () => {
	const f = fixture();
	f.ctx.model = undefined;
	assert.throws(f.send, /no selected model/);
	assert.equal(listTalkToMain(f.channel.channelDir, f.manifest).length, 1);
	assert.deepEqual(f.sent, []);
});

test("enqueues behind existing work once instead of waiting outside Pi", () => {
	const f = fixture();
	f.queue();
	f.busy();
	assert.equal(f.send(), "sent");
	assert.equal(f.send(), "waiting");
	assert.equal(f.sent.length, 1);
});

test("manual compaction without an active agent waits instead of starting a competing run", () => {
	const f = fixture();
	f.busy();
	f.ctx.signal = undefined;
	assert.equal(f.send(), "waiting");
	assert.deepEqual(f.sent, []);
	f.ctx.isIdle = () => true;
	assert.equal(f.send(), "sent");
});

test("reports unchanged protocol errors once and reports again after recovery", () => {
	const f = fixture();
	const errors = new ProtocolErrors();
	errors.report(f.ctx, "run", new Error("Bad JSON"));
	errors.report(f.ctx, "run", new Error("Bad JSON"));
	assert.equal(f.warnings.length, 1);
	errors.clear("run");
	errors.report(f.ctx, "run", new Error("Bad JSON"));
	assert.equal(f.warnings.length, 2);
});
