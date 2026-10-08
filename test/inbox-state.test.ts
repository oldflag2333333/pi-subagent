import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createChannel, readManifest, talkToMain } from "../src/channel.js";
import { bindInboxEvents } from "../src/inbox-state.js";
import { deliverTalk } from "../src/talk-delivery.js";

let root: string;
let previous: string | undefined;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "facets-inbox-state-")); previous = process.env.XDG_RUNTIME_DIR; process.env.XDG_RUNTIME_DIR = root; });
afterEach(() => { if (previous === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = previous; fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
	const channel = createChannel({ runId: "run", mainSessionId: "main", title: "Review", task: "Review", cwd: root,
		profile: { version: 1, name: "reviewer", tools: ["read"], source: "global", sourcePath: "/tmp/profile.json", resolvedSkills: [], resolvedExtensions: [] },
	});
	const manifest = readManifest(channel.channelDir);
	const session = SessionManager.inMemory(root);
	const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
	const sent: any[] = [];
	const ctx = { model: {}, sessionManager: session, isIdle: () => false, hasPendingMessages: () => true,
		signal: new AbortController().signal,
	} as unknown as ExtensionContext;
	const pi = { on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		sendUserMessage: (message: any) => sent.push(message),
	} as unknown as ExtensionAPI;
	let wakes = 0;
	bindInboxEvents(pi, () => ctx, () => { wakes++; });
	const fire = (event: string, data: unknown = {}) => handlers.get(event)?.forEach((handler) => handler(data, ctx));
	const message = talkToMain(channel.channelDir, manifest, "Reply");
	const send = () => deliverTalk(pi, ctx, channel.channelDir, manifest, "to-main", message, "Inbox content");
	return { channel, manifest, message, session, ctx, pi, sent, fire, send, wakes: () => wakes };
}

test("busy user-message follow-ups enter the native queue once before being recorded", () => {
	const f = fixture();
	f.fire("agent_start");
	assert.equal(f.send(), "sent");
	assert.equal(f.session.getEntries().length, 0);
	assert.equal(f.send(), "waiting");
	assert.equal(f.sent.length, 1);
});

test("failed submission remains retryable", () => {
	const f = fixture();
	const send = f.pi.sendUserMessage;
	f.pi.sendUserMessage = () => { throw new Error("Cannot enqueue"); };
	assert.throws(f.send, /Cannot enqueue/);
	f.pi.sendUserMessage = send;
	assert.equal(f.send(), "sent");
	assert.equal(f.sent.length, 1);
});

test("receipt leaves exactly one native user-message record", () => {
	const f = fixture();
	f.send();
	const accepted = f.sent[0];
	f.session.appendMessage({ role: "user", content: accepted, timestamp: Date.now() });
	assert.equal(f.send(), "acknowledged");
	assert.equal(f.session.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "user").length, 1);
	assert.equal(f.sent.length, 1);
});

test("in-flight state survives extension replacement against the same native session queue", () => {
	const f = fixture();
	f.send();
	const replacement = { ...f.ctx };
	assert.equal(deliverTalk(f.pi, replacement, f.channel.channelDir, f.manifest, "to-main", f.message, "Inbox"), "waiting");
	assert.equal(f.sent.length, 1);
});

test("normal settlement retries withdrawn busy follow-ups, but abort alone does not duplicate retained queues", () => {
	const f = fixture();
	f.fire("agent_start");
	f.send();
	f.fire("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] });
	f.fire("agent_settled");
	assert.equal(f.send(), "waiting");
	assert.equal(f.sent.length, 1);
	f.ctx.signal = new AbortController().signal;
	f.fire("agent_start");
	f.fire("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
	f.fire("agent_settled");
	assert.equal(f.send(), "sent");
	assert.equal(f.sent.length, 2);
	assert.equal(f.wakes(), 3);
});

test("abort before an assistant response also preserves in-flight state", () => {
	const f = fixture();
	const controller = new AbortController();
	f.ctx.signal = controller.signal;
	f.fire("agent_start");
	f.send();
	controller.abort();
	f.fire("agent_end", { messages: [] });
	f.fire("agent_settled");
	assert.equal(f.send(), "waiting");
	assert.equal(f.sent.length, 1);
});

test("a late abort from a previous run does not poison recovery for a newer run", () => {
	const f = fixture();
	const old = new AbortController();
	f.ctx.signal = old.signal;
	f.fire("agent_start");
	f.ctx.signal = new AbortController().signal;
	f.fire("agent_start");
	f.send();
	old.abort();
	f.fire("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
	f.fire("agent_settled");
	assert.equal(f.send(), "sent");
	assert.equal(f.sent.length, 2);
});
