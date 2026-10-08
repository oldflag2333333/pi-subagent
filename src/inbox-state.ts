import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MESSAGE_TYPE, type TalkDirection } from "./channel.js";
import type { DelegateManifest, TalkMessage } from "./types.js";
import { readTalkReceipt } from "./talk-message.js";

type ReadonlySessionManager = ExtensionContext["sessionManager"];
interface PendingTalk {
	queued: boolean;
	queuedWhileBusy: boolean;
	runSerial: number;
}
interface DeliveryState {
	pending: Map<string, PendingTalk>;
	runSerial: number;
	aborted: boolean;
	active: boolean;
}

// Pi can retain native message queues across /reload. Retain only their
// delivery state across extension replacement, keyed weakly by the session.
const STATE_KEY = Symbol.for("pi-facets.inbox-state.v1");
const globals = globalThis as unknown as Record<symbol, unknown>;
const states = (globals[STATE_KEY] ??= new WeakMap<ReadonlySessionManager, DeliveryState>()) as WeakMap<ReadonlySessionManager, DeliveryState>;
function state(ctx: ExtensionContext): DeliveryState {
	let value = states.get(ctx.sessionManager);
	if (!value) {
		value = { pending: new Map(), runSerial: 0, aborted: false, active: false };
		states.set(ctx.sessionManager, value);
	}
	return value;
}
function key(direction: TalkDirection, runId: string, messageId: string): string {
	return `${direction}:${runId}:${messageId}`;
}

export function rememberTalk(ctx: ExtensionContext, direction: TalkDirection, manifest: DelegateManifest, message: TalkMessage): PendingTalk {
	const value = state(ctx);
	const id = key(direction, manifest.runId, message.id);
	let pending = value.pending.get(id);
	if (!pending) {
		pending = { queued: false, queuedWhileBusy: false, runSerial: value.runSerial };
		value.pending.set(id, pending);
	}
	return pending;
}
export function forgetTalk(ctx: ExtensionContext, direction: TalkDirection, runId: string, messageId: string): void {
	state(ctx).pending.delete(key(direction, runId, messageId));
}
/** Queue behind streaming work, but never compete with manual compaction or prompt preflight. */
export function canUseNativeQueue(ctx: ExtensionContext): boolean {
	const value = state(ctx);
	// sendUserMessage awaits input/auth hooks before Pi becomes busy. Submit only
	// one idle prompt at a time; its receipt or agent_start will wake the rest.
	if (ctx.isIdle()) return ![...value.pending.values()].some((pending) => pending.queued && !pending.queuedWhileBusy);
	return value.active || ctx.signal !== undefined;
}
export function markTalkQueued(ctx: ExtensionContext, pending: PendingTalk): void {
	pending.queued = true;
	pending.queuedWhileBusy = !ctx.isIdle();
	pending.runSerial = state(ctx).runSerial;
}

export function bindInboxEvents(pi: ExtensionAPI, getContext: () => ExtensionContext | undefined, wake: () => void): void {
	const wakePending = () => {
		const ctx = getContext();
		if (ctx && state(ctx).pending.size > 0) wake();
	};
	pi.on("agent_start", () => {
		const ctx = getContext();
		if (!ctx) return;
		const value = state(ctx);
		value.runSerial++;
		value.aborted = ctx.signal?.aborted === true;
		value.active = true;
		const runSerial = value.runSerial;
		ctx.signal?.addEventListener("abort", () => { if (value.runSerial === runSerial) value.aborted = true; }, { once: true });
		wakePending();
	});
	pi.on("agent_end", (event) => {
		const ctx = getContext();
		if (!ctx) return;
		const last = [...event.messages].reverse().find((message) => message.role === "assistant");
		state(ctx).aborted ||= ctx.signal?.aborted === true || (last?.role === "assistant" && last.stopReason === "aborted");
	});
	pi.on("message_end", (event) => {
		if (readTalkReceipt(event.message)
			|| (event.message.role === "custom" && event.message.customType === MESSAGE_TYPE)) wake();
	});
	pi.on("turn_start", wakePending);
	pi.on("model_select", wakePending);
	pi.on("session_compact", wakePending);
	pi.on("session_compact_failed", wakePending);
	pi.on("agent_settled", () => {
		const ctx = getContext();
		if (!ctx) return;
		const value = state(ctx);
		value.active = false;
		// A normal settle has drained native follow-ups. Missing receipts then
		// indicate withdrawn messages. Abort alone can leave the queue intact:
		// keep in-flight state until the next normal run or a fresh session.
		if (!value.aborted) {
			for (const pending of value.pending.values()) {
				if (pending.queuedWhileBusy && pending.runSerial <= value.runSerial) pending.queued = false;
			}
		}
		wakePending();
	});
}
