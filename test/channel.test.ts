import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
	createChannel,
	channelPath,
	clearActiveTurn,
	clearInterrupt,
	listTalkToSub,
	listTalkToMain,
	readSubClosed,
	readSubSessionInfo,
	readClose,
	readManifest,
	readActiveTurn,
	readInterrupt,
	removeChannel,
	removeTalk,
	talkToSub,
	talkToMain,
	writeSubClosed,
	writeSubSessionInfo,
	writeClose,
	writeActiveTurn,
	writeInterrupt,
	writeAtomicJson,
} from "../src/channel.js";

const profile = {
	version: 1 as const,
	name: "reviewer",
	description: "Review only",
	tools: ["read", "grep"],
	thinkingLevel: "high",
	instructions: "Review the code without modifying files.",
	source: "global" as const,
	sourcePath: "/tmp/reviewer.json",
	resolvedSkills: [],
	resolvedExtensions: [],
};

let root: string;
let previousRuntimeDir: string | undefined;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-facets-test-"));
	previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
	process.env.XDG_RUNTIME_DIR = root;
});

afterEach(() => {
	if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
	else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
	fs.rmSync(root, { recursive: true, force: true });
});

function channel() {
	return createChannel({
		runId: "run-1",
		mainSessionId: "session-1",
		title: "Review auth",
		task: "Review the auth flow.",
		cwd: "/tmp/project",
		profile,
	});
}

test("creates an isolated manifest and round-trips talk in both directions", () => {
	const created = channel();
	const manifest = readManifest(created.channelDir);
	assert.equal(manifest.runId, "run-1");
	assert.equal(manifest.token.length, 64);
	assert.equal(manifest.profile.instructions, "Review the code without modifying files.");

	const mainMessage = talkToMain(created.channelDir, manifest, "Delivery from Sub");
	const subMessage = talkToSub(created.channelDir, manifest, "Feedback from Main");
	assert.deepEqual(listTalkToMain(created.channelDir, manifest), [mainMessage]);
	assert.deepEqual(listTalkToSub(created.channelDir, manifest), [subMessage]);

	removeTalk(created.channelDir, "to-main", mainMessage.id);
	removeTalk(created.channelDir, "to-sub", subMessage.id);
	assert.deepEqual(listTalkToMain(created.channelDir, manifest), []);
	assert.deepEqual(listTalkToSub(created.channelDir, manifest), []);
	removeChannel(created.channelDir);
});

test("a failed manifest write cleans up the partially created channel", () => {
	assert.throws(() => createChannel({
		runId: "run-1", mainSessionId: "session-1", title: "Review", task: "x".repeat(1024 * 1024), cwd: root, profile,
	}), /manifest.json exceeds/);
	assert.equal(fs.existsSync(channelPath("session-1", "run-1")), false);
});

test("duplicate run IDs cannot overwrite an existing capability token", () => {
	const created = channel();
	assert.throws(channel, /EEXIST/);
	assert.equal(readManifest(created.channelDir).token, created.token);
});

test("orders messages by persisted sequence even within one millisecond or after a clock rollback", (t) => {
	t.mock.method(Date, "now", () => 1000);
	const created = channel();
	const manifest = readManifest(created.channelDir);
	const first = talkToMain(created.channelDir, manifest, "First");
	const second = talkToMain(created.channelDir, manifest, "Second");
	t.mock.method(Date, "now", () => 500);
	const third = talkToMain(created.channelDir, manifest, "Third");
	assert.deepEqual([first.sequence, second.sequence, third.sequence], [1, 2, 3]);
	assert.deepEqual(listTalkToMain(created.channelDir, manifest).map((message) => message.message), ["First", "Second", "Third"]);
	assert.equal(talkToSub(created.channelDir, manifest, "Independent").sequence, 1);
});

test("rejects a corrupt sequence counter instead of restarting the sequence", () => {
	const created = channel();
	const manifest = readManifest(created.channelDir);
	fs.writeFileSync(path.join(created.channelDir, "to-main-sequence.json"), "null");
	assert.throws(() => talkToMain(created.channelDir, manifest, "Must not send"), /Invalid Facets talk sequence counter/);
	assert.deepEqual(listTalkToMain(created.channelDir, manifest), []);
});

test("late channel writes cannot recreate a channel after closure", () => {
	const created = channel();
	const manifest = readManifest(created.channelDir);
	removeChannel(created.channelDir);
	assert.throws(() => talkToMain(created.channelDir, manifest, "Too late"), /ENOENT/);
	assert.throws(() => writeSubClosed(created.channelDir, manifest, "Too late"), /ENOENT/);
	assert.equal(fs.existsSync(created.channelDir), false);
});

test("limits the bytes actually written, including JSON formatting", () => {
	const created = channel();
	const value = { text: "x".repeat(20) };
	const compactBytes = Buffer.byteLength(JSON.stringify(value));
	assert.throws(() => writeAtomicJson(path.join(created.channelDir, "size.json"), value, compactBytes), /exceeds/);
	assert.equal(fs.existsSync(path.join(created.channelDir, "size.json")), false);
	assert.equal(fs.readdirSync(created.channelDir).some((name) => name.endsWith(".tmp")), false);
});

test("rejects talk messages with a different capability token", () => {
	const created = channel();
	const manifest = readManifest(created.channelDir);
	const forged = {
		version: 1,
		id: "forged",
		runId: manifest.runId,
		token: "wrong",
		createdAt: Date.now(),
		message: "Leak context",
	};
	fs.writeFileSync(path.join(created.channelDir, "to-main", "forged.json"), JSON.stringify(forged));
	assert.deepEqual(listTalkToMain(created.channelDir, manifest), []);
});

test("round-trips persistent Sub session identity", () => {
	const created = channel();
	const manifest = readManifest(created.channelDir);
	const info = writeSubSessionInfo(created.channelDir, manifest, {
		sessionId: "sub-session-id",
		sessionFile: "/tmp/sub.jsonl",
	});
	assert.deepEqual(readSubSessionInfo(created.channelDir, manifest), info);
});

test("binds an interrupt to one authenticated active turn", () => {
	const created = channel();
	const manifest = readManifest(created.channelDir);
	const turn = writeActiveTurn(created.channelDir, manifest);
	assert.deepEqual(readActiveTurn(created.channelDir, manifest), turn);
	const request = writeInterrupt(created.channelDir, manifest, turn);
	assert.deepEqual(readInterrupt(created.channelDir, manifest), request);
	assert.equal(readInterrupt(created.channelDir, { ...manifest, token: "wrong" }), undefined);
	const nextTurn = writeActiveTurn(created.channelDir, manifest);
	clearActiveTurn(created.channelDir, turn);
	assert.deepEqual(readActiveTurn(created.channelDir, manifest), nextTurn);
	clearInterrupt(created.channelDir);
	assert.equal(readInterrupt(created.channelDir, manifest), undefined);
	clearActiveTurn(created.channelDir, nextTurn);
	assert.equal(readActiveTurn(created.channelDir, manifest), undefined);
});

test("round-trips Main close and manual Sub closure", () => {
	const created = channel();
	const manifest = readManifest(created.channelDir);
	writeClose(created.channelDir, manifest, "Accepted");
	assert.equal(readClose(created.channelDir, manifest)?.reason, "Accepted");
	writeSubClosed(created.channelDir, manifest, "Closed manually");
	assert.equal(readSubClosed(created.channelDir, manifest)?.reason, "Closed manually");
});
