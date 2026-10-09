import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createParentWake, PARENT_WAKE_TEXT, WAKE_PENDING_MS } from "../src/parent-wake.js";

const message = { customType: "subagent-message", content: "A peer result", display: true, details: { id: "message" } };
const options = { triggerTurn: true, deliverAs: "followUp" as const };

function fixture() {
	let idle = true;
	let time = 0;
	const cards: Parameters<ExtensionAPI["sendMessage"]>[] = [];
	const prompts: Parameters<ExtensionAPI["sendUserMessage"]>[] = [];
	const pi = {
		sendMessage: (...args: Parameters<ExtensionAPI["sendMessage"]>) => { cards.push(args); },
		sendUserMessage: (...args: Parameters<ExtensionAPI["sendUserMessage"]>) => { prompts.push(args); },
	};
	const ctx = { isIdle: () => idle, sessionManager: SessionManager.inMemory() };
	const create = () => {
		const wake = createParentWake(pi, () => time);
		wake.bindSession(ctx);
		return wake;
	};
	return { pi, ctx, cards, prompts, create, wake: create(), busy: () => { idle = false; }, idle: () => { idle = true; }, advance: () => { time += WAKE_PENDING_MS; } };
}

test("idle peer messages retain their custom cards and share one fixed user wake", () => {
	const f = fixture();
	f.wake.sendMessage(message, options);
	f.wake.sendMessage({ ...message, content: "/skill:never-execute-this" }, options);
	assert.deepEqual(f.cards, [[message, { triggerTurn: false }], [{ ...message, content: "/skill:never-execute-this" }, { triggerTurn: false }]]);
	assert.deepEqual(f.prompts, [[PARENT_WAKE_TEXT, { deliverAs: "steer" }]]);
	assert.ok(!PARENT_WAKE_TEXT.includes(message.content));
});

test("busy messages keep the existing custom follow-up path without a user wake", () => {
	const f = fixture();
	f.busy();
	f.wake.sendMessage(message, options);
	assert.deepEqual(f.cards, [[message, options]]);
	assert.deepEqual(f.prompts, []);
});

test("non-triggering messages are passed through without a wake", () => {
	const f = fixture();
	f.wake.sendMessage(message, { triggerTurn: false });
	f.wake.sendMessage(message);
	assert.deepEqual(f.cards, [[message, { triggerTurn: false }], [message, undefined]]);
	assert.deepEqual(f.prompts, []);
});

test("reload retains a pending wake across replacement extension instances", () => {
	const f = fixture();
	f.wake.sendMessage(message, options);
	f.wake.sessionShutdown("reload");
	const replacement = f.create();
	replacement.sendMessage(message, options);
	assert.equal(f.prompts.length, 1);
	replacement.agentStarted();
	replacement.sendMessage(message, options);
	assert.equal(f.prompts.length, 2, "The next idle run needs a fresh wake");
});

test("switching session IDs on the same manager does not inherit a wake reservation", () => {
	const f = fixture();
	f.wake.sendMessage(message, options);
	f.ctx.sessionManager.newSession();
	f.wake.bindSession(f.ctx);
	f.wake.sendMessage(message, options);
	assert.equal(f.prompts.length, 2);
});

test("a later idle message can retry an abandoned wake after the deadline", () => {
	const f = fixture();
	f.wake.sendMessage(message, options);
	f.advance();
	f.busy();
	f.wake.sendMessage(message, options);
	assert.equal(f.prompts.length, 1, "Do not launch another wake during preflight or active work");
	f.idle();
	f.wake.sendMessage(message, options);
	assert.equal(f.prompts.length, 2);
});

test("shutdown other than reload releases the wake reservation", () => {
	const f = fixture();
	f.wake.sendMessage(message, options);
	f.wake.sessionShutdown("quit");
	f.create().sendMessage(message, options);
	assert.equal(f.prompts.length, 2);
});

test("failed custom submission never sends a user wake", () => {
	const f = fixture();
	f.pi.sendMessage = () => { throw new Error("Append failed"); };
	assert.throws(() => f.wake.sendMessage(message, options), /Append failed/);
	assert.deepEqual(f.prompts, []);
});

test("failed user wakes remain retryable without appending another custom message", () => {
	const f = fixture();
	const send = f.pi.sendUserMessage;
	f.pi.sendUserMessage = () => { throw new Error("Wake failed"); };
	assert.throws(() => f.wake.sendMessage(message, options), /Wake failed/);
	const reloaded = f.create();
	f.busy();
	assert.equal(reloaded.retryFailedWake(), false);
	f.pi.sendUserMessage = send;
	f.idle();
	assert.equal(reloaded.retryFailedWake(), true);
	assert.equal(reloaded.retryFailedWake(), true);
	assert.equal(f.cards.length, 1);
	assert.equal(f.prompts.length, 1);
});
