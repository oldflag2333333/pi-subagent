import type { TalkDirection } from "./channel.js";

export interface TalkReceipt {
	direction: TalkDirection;
	runId: string;
	messageId: string;
}

const PREFIX = "[Facets delivery v1] ";

/** User messages have no custom details field. Keep receipt identity in their text. */
export function formatTalkInput(receipt: TalkReceipt, content: string): string {
	return `${PREFIX}${JSON.stringify(receipt)}\n\n${content}`;
}

/** Only the leading marker of a user message can acknowledge a delivery. */
export function readTalkReceipt(message: { role: string; content?: unknown }): TalkReceipt | undefined {
	if (message.role !== "user") return;
	const content = message.content;
	const text = typeof content === "string" ? content
		: Array.isArray(content) && content[0]?.type === "text" ? content[0].text : undefined;
	if (typeof text !== "string" || !text.startsWith(PREFIX)) return;
	try {
		const value = JSON.parse(text.slice(PREFIX.length).split("\n", 1)[0]!);
		if (value && (value.direction === "to-main" || value.direction === "to-sub")
			&& typeof value.runId === "string" && value.runId.length > 0
			&& typeof value.messageId === "string" && value.messageId.length > 0) {
			return { direction: value.direction, runId: value.runId, messageId: value.messageId };
		}
	} catch {}
	return undefined;
}
