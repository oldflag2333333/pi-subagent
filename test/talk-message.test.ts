import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTalkInput, readTalkReceipt } from "../src/talk-message.js";

const receipt = { direction: "to-main" as const, runId: "run", messageId: "message" };

test("delivery identity survives native text-block user messages without changing peer content", () => {
	const body = "/skill:review\n\nUnicode 中文 and **Markdown**.";
	const text = formatTalkInput(receipt, body);
	assert.ok(text.endsWith("\n\n" + body));
	assert.deepEqual(readTalkReceipt({ role: "user", content: text }), receipt);
	assert.deepEqual(readTalkReceipt({ role: "user", content: [{ type: "text", text }] }), receipt);
});

test("non-user messages, quoted markers, and malformed identities cannot be receipts", () => {
	const text = formatTalkInput(receipt, "Hello");
	for (const role of ["assistant", "toolResult", "custom", "system"]) {
		assert.equal(readTalkReceipt({ role, content: text }), undefined);
	}
	for (const content of [
		"Quoted:\n" + text,
		"\n" + text,
		[{ type: "text", text: "Quote" }, { type: "text", text }],
		"[Facets delivery v1] {broken",
		"[Facets delivery v1] null",
		'[Facets delivery v1] {"direction":"invalid","runId":"run","messageId":"message"}',
		'[Facets delivery v1] {"direction":"to-main","runId":"","messageId":"message"}',
		'[Facets delivery v1] {"direction":"to-main","runId":"run","messageId":123}',
		null,
	]) {
		assert.equal(readTalkReceipt({ role: "user", content }), undefined);
	}
});
