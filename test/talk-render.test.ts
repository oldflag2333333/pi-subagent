import assert from "node:assert/strict";
import { test } from "node:test";
import { talkView } from "../src/talk-render.js";

test("shows the first three talk lines by default with native-style counts", () => {
	const message = Array.from({ length: 25 }, (_, index) => `line ${index + 1}`).join("\n");
	const view = talkView(message, false);
	assert.equal(view.lines.length, 3);
	assert.equal(view.lines[0], "line 1");
	assert.equal(view.lines.at(-1), "line 3");
	assert.equal(view.remaining, 22);
	assert.equal(view.totalLines, 25);
});

test("shows complete normalized talk content when expanded", () => {
	const view = talkView("first\r\nsecond\r\n", true);
	assert.deepEqual(view.lines, ["first", "second"]);
	assert.equal(view.remaining, 0);
	assert.equal(view.totalLines, 2);
});
