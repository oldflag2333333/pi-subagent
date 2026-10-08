import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { resolveResumableSubSession, selectResumableSubSessions } from "../src/sessions.js";
import type { RunSnapshot } from "../src/types.js";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-sessions-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function run(id: string, overrides: Partial<RunSnapshot> = {}): RunSnapshot {
	const file = path.join(root, `${id}.jsonl`);
	fs.writeFileSync(file, "");
	return {
		version: 1, runId: id, mainSessionId: "main", title: id, cwd: root, profileName: "reviewer",
		sessionPersistence: "persistent", channelDir: path.join(root, id),
		createdAt: 1, updatedAt: 2, closedAt: 2, subSessionId: id, subSessionFile: file, ...overrides,
	};
}

test("selects only this Main's confirmed-closed persistent sessions with saved files", () => {
	const missing = run("missing");
	fs.unlinkSync(missing.subSessionFile!);
	const selected = selectResumableSubSessions([
		run("open", { closedAt: undefined }),
		run("foreign-open", { mainSessionId: "other", closedAt: undefined }),
		run("foreign-closed", { mainSessionId: "other" }),
		run("ephemeral", { sessionPersistence: "ephemeral" }),
		run("no-id", { subSessionId: undefined }),
		run("no-file", { subSessionFile: undefined }),
		run("directory", { subSessionFile: root }), missing,
		run("closed"), run("manual", { origin: "manual", purpose: "Review MR", updatedAt: 3 }),
	], "main");
	assert.deepEqual(selected.map((session) => session.sessionId), ["manual", "closed"]);
	assert.equal(selected[0]!.origin, "manual");
	assert.equal(selected[0]!.purpose, "Review MR");
	assert.equal(selected[1]!.profileName, "reviewer");
});

test("deduplicates resumed sessions and hides prior closed runs while the session is open", () => {
	const old = run("old", { subSessionId: "shared" });
	const latest = run("new", { subSessionId: "shared", createdAt: 3, updatedAt: 4 });
	const open = run("reopened", { subSessionId: "shared", createdAt: 5, closedAt: undefined });
	assert.equal(selectResumableSubSessions([latest, old], "main")[0]!.title, "new");
	// No runtime channel exists: absence alone must not make the live run resumable.
	assert.deepEqual(selectResumableSubSessions([old, latest, open], "main"), []);
});

test("resolves only supplied owned sessions and keeps manual sessions user-invoked", () => {
	const sessions = selectResumableSubSessions([
		run("session-a"), run("session-b"), run("manual", { origin: "manual" }),
		run("foreign", { mainSessionId: "other" }),
	], "main");
	assert.equal(resolveResumableSubSession("session-a", sessions).sessionId, "session-a");
	assert.equal(resolveResumableSubSession("man", sessions, true).sessionId, "manual");
	assert.throws(() => resolveResumableSubSession("session-", sessions), /ambiguous/);
	assert.throws(() => resolveResumableSubSession("manual", sessions), /belonging to this Main/);
	assert.throws(() => resolveResumableSubSession("foreign", sessions, true), /belonging to this Main/);
});
