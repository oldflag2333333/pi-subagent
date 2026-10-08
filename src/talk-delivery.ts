import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MESSAGE_TYPE, removeTalk, type TalkDirection } from "./channel.js";
import type { DelegateManifest, TalkMessage } from "./types.js";
import { formatTalkInput, readTalkReceipt } from "./talk-message.js";
import { canUseNativeQueue, forgetTalk, markTalkQueued, rememberTalk } from "./inbox-state.js";

function hasReceipt(ctx: ExtensionContext, direction: TalkDirection, runId: string, messageId: string): boolean {
	return ctx.sessionManager.getEntries().some((entry) => {
		// Old custom-message receipts still count after upgrading or reloading.
		const details = entry.type === "message" ? readTalkReceipt(entry.message)
			: entry.type === "custom_message" && entry.customType === MESSAGE_TYPE
				? entry.details as { direction?: string; runId?: string; messageId?: string } | undefined
				: undefined;
		return details?.direction === direction && details.runId === runId && details.messageId === messageId;
	});
}

/** pi.sendUserMessage is fire-and-forget; its return is not a session receipt. */
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
		forgetTalk(ctx, direction, manifest.runId, message.id);
		removeTalk(channelDir, direction, message.id);
		return "acknowledged";
	}
	const pending = rememberTalk(ctx, direction, manifest, message);
	if (pending.queued || !canUseNativeQueue(ctx)) return "waiting";
	if (!ctx.model) throw new Error("Cannot deliver talk: the receiving Pi has no selected model.");
	markTalkQueued(ctx, pending);
	try {
		// Pi owns waiting behind current work, not Facets. In-flight IDs prevent
		// repeated file notifications from submitting the same follow-up twice.
		pi.sendUserMessage(formatTalkInput({ direction, runId: manifest.runId, messageId: message.id }, content), {
			deliverAs: "followUp",
			// Peer text is input, not an instruction to execute slash commands or templates.
			expandPromptTemplates: false,
		});
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
		const message = `Facets channel error (${key}): ${error instanceof Error ? error.message : String(error)}`;
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
