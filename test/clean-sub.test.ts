import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { channelPath, runtimeRoot } from "../src/channel.js";
import { subSessionDir, subSessionsRoot } from "../src/sessions.js";
import { cleanSubFiles, registerCleanSubCommand } from "../src/commands/clean-sub.js";

let root: string;
let previous: Record<string, string | undefined>;
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-clean-"));
	previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR };
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
	process.env.XDG_RUNTIME_DIR = path.join(root, "runtime");
});
afterEach(() => {
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
	fs.rmSync(root, { recursive: true, force: true });
});

function session(id: string, directory = path.join(root, "agent", "sessions", "--project--")): string {
	fs.mkdirSync(directory, { recursive: true });
	const file = path.join(directory, `${id}.jsonl`);
	fs.writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, cwd: root })}\n`);
	return file;
}

function channel(main: string, run = "run"): string {
	const directory = channelPath(main, run);
	fs.mkdirSync(path.join(directory, "to-main"), { recursive: true });
	fs.mkdirSync(path.join(directory, "to-sub"));
	for (const file of ["manifest.json", "session.json", "active-turn.json", "interrupt.json", "close.json", "closed.json", "to-main-sequence.json", "to-sub-sequence.json", "pending.tmp", "to-main/message.json", "to-sub/message.json"]) {
		fs.writeFileSync(path.join(directory, file), "{}");
	}
	return directory;
}

test("removes all orphaned communication files but retains existing and current Main channels", () => {
	const deleted = session("deleted-main");
	fs.unlinkSync(deleted);
	const orphan = channel("deleted-main");
	channel("deleted-main", "second-run");
	const live = channel("saved-main");
	session("saved-main");
	const current = channel("current-main"); // The current Main may be in memory only.
	const subFile = session("persistent-sub");
	const config = path.join(root, "agent", "subagent", "profiles", "reviewer", "instructions.md");
	fs.mkdirSync(path.dirname(config), { recursive: true });
	fs.writeFileSync(config, "Keep this role.");
	assert.deepEqual(cleanSubFiles("current-main", ""), { removed: 1, errors: [] });
	assert.equal(fs.existsSync(path.dirname(orphan)), false);
	assert.ok(fs.existsSync(live));
	assert.ok(fs.existsSync(current));
	assert.ok(fs.existsSync(subFile));
	assert.equal(fs.readFileSync(config, "utf8"), "Keep this role.");
	assert.deepEqual(cleanSubFiles("current-main", ""), { removed: 0, errors: [] });
});

test("removes orphaned managed sessions even when no runtime directory remains", () => {
	const orphan = session("sub-gone", subSessionDir("gone-main"));
	const current = session("sub-current", subSessionDir("current-main"));
	const saved = session("sub-saved", subSessionDir("saved-main"));
	session("saved-main");
	const legacy = session("legacy-sub");
	assert.equal(fs.existsSync(runtimeRoot()), false);
	assert.deepEqual(cleanSubFiles("current-main", ""), { removed: 1, errors: [] });
	assert.equal(fs.existsSync(path.dirname(orphan)), false);
	assert.ok(fs.existsSync(current));
	assert.ok(fs.existsSync(saved));
	assert.ok(fs.existsSync(legacy), "Never guess ownership of sessions outside the managed store");
	assert.deepEqual(cleanSubFiles("current-main", ""), { removed: 0, errors: [] });
});

test("removes both owned directories and does not count a Sub file as its deleted Main", () => {
	channel("gone-main");
	session("gone-main", subSessionDir("gone-main"));
	assert.deepEqual(cleanSubFiles("current-main", ""), { removed: 2, errors: [] });
	assert.equal(fs.existsSync(subSessionDir("gone-main")), false);
});

test("a symlinked managed session root aborts cleanup before any deletion", () => {
	const outside = path.join(root, "outside");
	fs.mkdirSync(path.join(outside, "keep"), { recursive: true });
	fs.mkdirSync(path.dirname(subSessionsRoot()), { recursive: true });
	fs.symlinkSync(outside, subSessionsRoot(), "dir");
	const orphan = channel("gone");
	assert.throws(() => cleanSubFiles("current", ""), /symlinked directory/);
	assert.ok(fs.existsSync(orphan));
	assert.ok(fs.existsSync(path.join(outside, "keep")));
});

test("checks all default projects plus the current custom session directory", () => {
	const other = channel("other-project-main");
	session("other-project-main", path.join(root, "agent", "sessions", "--other-project--"));
	const custom = path.join(root, "custom-sessions");
	session("custom-main", custom);
	const customChannel = channel("custom-main");
	const orphan = channel("gone");
	assert.equal(cleanSubFiles("current", custom).removed, 1);
	assert.ok(fs.existsSync(other));
	assert.ok(fs.existsSync(customChannel));
	assert.equal(fs.existsSync(orphan), false);
});

test("aborts before any deletion when session discovery encounters an invalid header", () => {
	const orphan = channel("gone");
	const persistent = session("sub", subSessionDir("gone"));
	const corrupt = session("corrupt");
	fs.writeFileSync(corrupt, "{broken\n");
	assert.throws(() => cleanSubFiles("current", ""), /Cannot inspect session/);
	assert.ok(fs.existsSync(orphan));
	assert.ok(fs.existsSync(persistent));
});

test("does not mistake an unreadable session path for a deleted Main", () => {
	const orphan = channel("gone");
	const file = session("unreadable");
	fs.unlinkSync(file);
	fs.mkdirSync(file);
	assert.throws(() => cleanSubFiles("current", ""));
	assert.ok(fs.existsSync(orphan));
});

test("does not follow symlinks out of the runtime directory", () => {
	const outside = path.join(root, "keep");
	fs.mkdirSync(outside);
	fs.writeFileSync(path.join(outside, "important"), "keep");
	fs.mkdirSync(runtimeRoot(), { recursive: true });
	fs.symlinkSync(outside, path.join(runtimeRoot(), "symlink-main"), "dir");
	const orphan = channel("gone");
	fs.symlinkSync(outside, path.join(orphan, "linked"), "dir");
	assert.equal(cleanSubFiles("current", "").removed, 1);
	assert.equal(fs.readFileSync(path.join(outside, "important"), "utf8"), "keep");
	assert.ok(fs.lstatSync(path.join(runtimeRoot(), "symlink-main")).isSymbolicLink());
});

test("an absent runtime directory is a no-op without creating an index", () => {
	assert.deepEqual(cleanSubFiles("current", ""), { removed: 0, errors: [] });
	assert.equal(fs.existsSync(path.join(root, "agent", "subagent")), false);
});

test("/clean-sub runs directly without a confirmation or model turn", async () => {
	let command: { handler: (args: string, ctx: ExtensionCommandContext) => unknown } | undefined;
	const pi = { registerCommand: (name: string, value: typeof command) => {
		assert.equal(name, "clean-sub");
		command = value;
	} } as unknown as ExtensionAPI;
	registerCleanSubCommand(pi);
	const notifications: string[] = [];
	const orphan = channel("gone");
	await command!.handler("", {
		sessionManager: { getSessionId: () => "current", getSessionDir: () => "" },
		ui: { notify: (message: string) => notifications.push(message) },
	} as unknown as ExtensionCommandContext);
	assert.equal(fs.existsSync(orphan), false);
	assert.match(notifications[0]!, /Removed 1 orphaned Sub data/);
	assert.match(notifications[0]!, /sessions and communication/);
});
