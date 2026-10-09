import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MESSAGE_TYPE, removeTalk, type TalkDirection } from "./channel.js";
import type { DelegateManifest, TalkMessage } from "./types.js";
import { readTalkReceipt } from "./talk-message.js";
import { parentWakeFor } from "./parent-wake.js";
import { canUseNativeQueue, forgetTalk, markTalkQueued, rememberTalk } from "./inbox-state.js";

function hasReceipt(ctx: ExtensionContext, direction: TalkDirection, runId: string, messageId: string): boolean {
	return ctx.sessionManager.getEntries().some((entry) => {
		// Accept both custom receipts and user-message receipts from v0.1.0.
		const details = entry.type === "message" ? readTalkReceipt(entry.message)
			: entry.type === "custom_message" && entry.customType === MESSAGE_TYPE
				? entry.details as { direction?: string; runId?: string; messageId?: string } | undefined
				: undefined;
		return details?.direction === direction && details.runId === runId && details.messageId === messageId;
	});
}

/** pi.sendMessage is fire-and-forget; its return is not a session receipt. */
export function deliverTalk(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	channelDir: string,
	manifest: DelegateManifest,
	direction: TalkDirection,
	message: TalkMessage,
	content: string,
): "acknowledged" | "waiting" | "sent" {
	if (hasReceipt(ctx, direction, manifest.runId, message.id)) {
		if (!parentWakeFor(pi, ctx).retryFailedWake()) return "waiting";
		forgetTalk(ctx, direction, manifest.runId, message.id);
		removeTalk(channelDir, direction, message.id);
		return "acknowledged";
	}
	const pending = rememberTalk(ctx, direction, manifest, message);
	if (pending.queued || !canUseNativeQueue(ctx)) return "waiting";
	if (!ctx.model) throw new Error("Cannot deliver talk: the receiving Pi has no selected model.");
	markTalkQueued(ctx, pending);
	try {
		// Pi owns waiting behind current work, not Pi Subagent. In-flight IDs prevent
		// repeated file notifications from submitting the same follow-up twice.
		// Keep peer content in the custom inbox card. Idle runs use a separate,
		// fixed user wake so Pi assembles the profile sections through its input pipeline.
		parentWakeFor(pi, ctx).sendMessage({
			customType: MESSAGE_TYPE,
			content,
			display: true,
			details: { title: manifest.title, message: message.message, direction, runId: manifest.runId, messageId: message.id },
		}, { deliverAs: "followUp", triggerTurn: true });
	} catch (error) {
		pending.queued = false;
		throw error;
	}
	// Some modes append synchronously. Otherwise lifecycle/watch wakes confirm receipt.
	if (hasReceipt(ctx, direction, manifest.runId, message.id)) {
		forgetTalk(ctx, direction, manifest.runId, message.id);
		removeTalk(channelDir, direction, message.id);
	}
	return "sent";
}

/** Report an unchanged protocol failure once, then allow retry on later polls. */
export class ProtocolErrors {
	private readonly reported = new Map<string, string>();

	report(ctx: ExtensionContext, key: string, error: unknown): void {
		const message = `Pi Subagent channel error (${key}): ${error instanceof Error ? error.message : String(error)}`;
		if (this.reported.get(key) === message) return;
		this.reported.set(key, message);
		let notified = false;
		try { ctx.ui.notify(message, "error"); notified = ctx.hasUI; } catch {}
		if (!notified) console.error(message);
	}

	clear(key: string): void {
		this.reported.delete(key);
	}
}
