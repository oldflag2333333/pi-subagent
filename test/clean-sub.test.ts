import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createChannel, runtimeRoot } from "../src/channel.js";
import { SUB_OWNER_ENTRY } from "../src/sessions.js";
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

function session(id: string, cwd = root, directory?: string, main?: { id: string; file?: string }): SessionManager {
	const manager = SessionManager.create(cwd, directory, { id });
	if (main) manager.appendCustomEntry(SUB_OWNER_ENTRY, {
		version: 1, subSessionId: id, mainSessionId: main.id, ...(main.file ? { mainSessionFile: main.file } : {}),
	});
	manager.appendMessage({ role: "user", content: "Fixture task", timestamp: Date.now() });
	return manager;
}

function sub(main: string, cwd = root, directory?: string, mainFile?: string): string {
	return session(`sub-${randomUUID()}`, cwd, directory, { id: main, file: mainFile }).getSessionFile()!;
}

function channel(mainSessionId: string, cwd = root, mainSessionFile?: string): string {
	return createChannel({
		runId: randomUUID(), mainSessionId, mainSessionFile, title: "Sub", task: "Review", cwd,
		profile: { version: 1, name: "reviewer", tools: ["read"], source: "global", sourcePath: "/tmp/profile.json", resolvedSkills: [], resolvedExtensions: [] },
	}).channelDir;
}

test("global cleanup deletes only orphaned native Subs and channels across all projects", async () => {
	const saved = session("saved-main");
	const live = sub(saved.getSessionId());
	const current = sub("current-main");
	const orphan = sub("deleted-main");
	const otherProject = sub("deleted-other-main", path.join(root, "other"));
	const ordinary = session("ordinary").getSessionFile()!;
	const orphanChannel = channel("deleted-main");
	const secondChannel = channel("deleted-main");
	const liveChannel = channel(saved.getSessionId());
	const currentChannel = channel("current-main");
	assert.deepEqual(await cleanSubFiles("current-main", ""), { removed: 2, removedChannels: 2, errors: [] });
	for (const file of [orphan, otherProject, orphanChannel, secondChannel]) assert.equal(fs.existsSync(file), false);
	for (const file of [saved.getSessionFile()!, live, current, ordinary, liveChannel, currentChannel]) assert.ok(fs.existsSync(file));
	assert.deepEqual(await cleanSubFiles("current-main", ""), { removed: 0, removedChannels: 0, errors: [] });
	assert.equal(fs.existsSync(path.join(root, "agent", "subagent")), false, "No separate store or index");
});

test("Sub files share Main's native directory and Pi discovers them normally", async () => {
	const main = session("main");
	const file = sub(main.getSessionId());
	assert.equal(path.dirname(file), main.getSessionDir());
	const discovered = await SessionManager.list(root);
	assert.equal(discovered.length, 2);
	assert.ok(discovered.some((item) => item.path === file && item.id.startsWith("sub-")));
	assert.equal((await cleanSubFiles("current", "")).removed, 0);
	fs.unlinkSync(main.getSessionFile()!);
	assert.equal((await cleanSubFiles("current", "")).removed, 1);
	assert.ok(fs.existsSync(main.getSessionDir()), "Never delete the shared session directory");
});

test("local cleanup targets only the current cwd, but finds Mains in other projects", async () => {
	const otherCwd = path.join(root, "other");
	const otherMain = session("other-main", otherCwd);
	const crossCwd = sub(otherMain.getSessionId());
	const localOrphan = sub("gone");
	const otherOrphan = sub("gone", otherCwd);
	const localChannel = channel("gone");
	const otherChannel = channel("gone", otherCwd);
	assert.deepEqual(await cleanSubFiles("current", "", root), { removed: 1, removedChannels: 1, errors: [] });
	assert.equal(fs.existsSync(localOrphan), false);
	assert.equal(fs.existsSync(localChannel), false);
	for (const file of [crossCwd, otherOrphan, otherChannel]) assert.ok(fs.existsSync(file));
	assert.equal((await cleanSubFiles("current", "")).removed, 1);
});

test("local cleanup filters session header cwd even in a shared custom store", async () => {
	const custom = path.join(root, "custom");
	const local = sub("gone", root, custom);
	const foreign = sub("gone", path.join(root, "other"), custom);
	assert.equal((await cleanSubFiles("current", custom, root)).removed, 1);
	assert.equal(fs.existsSync(local), false);
	assert.ok(fs.existsSync(foreign));
});

test("recorded Main paths protect sessions in custom stores outside native discovery", async () => {
	const main = session("custom-main", root, path.join(root, "custom"));
	const file = sub(main.getSessionId(), root, undefined, main.getSessionFile());
	const runtime = channel(main.getSessionId(), root, main.getSessionFile());
	assert.equal((await cleanSubFiles("current", "")).removed, 0);
	assert.ok(fs.existsSync(file));
	assert.ok(fs.existsSync(runtime));
	fs.unlinkSync(main.getSessionFile()!);
	assert.deepEqual(await cleanSubFiles("current", ""), { removed: 1, removedChannels: 1, errors: [] });
});

test("a moved Main is still recognized by ID in the native store", async () => {
	const main = session("main");
	const old = main.getSessionFile()!;
	const file = sub(main.getSessionId(), root, undefined, old);
	const destination = path.join(session("elsewhere", path.join(root, "elsewhere")).getSessionDir(), "moved.jsonl");
	fs.renameSync(old, destination);
	assert.equal((await cleanSubFiles("current", "")).removed, 0);
	assert.ok(fs.existsSync(file));
});

test("missing ownership and non-Sub IDs are never guessed from names or Main snapshots", async () => {
	const unowned = session(`sub-${randomUUID()}`).getSessionFile()!;
	const ordinary = session("ordinary", root, undefined, { id: "gone" }).getSessionFile()!;
	const result = await cleanSubFiles("current", "");
	assert.equal(result.removed, 0);
	assert.match(result.errors[0]!, /without owner metadata/);
	assert.ok(fs.existsSync(unowned));
	assert.ok(fs.existsSync(ordinary));
});

test("the current session file is protected even when its Main is missing", async () => {
	const current = session(`sub-${randomUUID()}`, root, undefined, { id: "gone" });
	assert.equal((await cleanSubFiles(current.getSessionId(), current.getSessionDir())).removed, 0);
	assert.ok(fs.existsSync(current.getSessionFile()!));
});

test("bad headers abort all cleanup before deleting any files", async () => {
	const orphan = sub("gone");
	const runtime = channel("gone");
	const bad = session("corrupt").getSessionFile()!;
	fs.writeFileSync(bad, "{broken\n");
	await assert.rejects(cleanSubFiles("current", ""), /Cannot inspect session/);
	assert.ok(fs.existsSync(orphan));
	assert.ok(fs.existsSync(runtime));
});

test("unreadable session paths are not mistaken for missing Mains", async () => {
	const orphan = sub("gone");
	const bad = session("bad").getSessionFile()!;
	fs.unlinkSync(bad);
	fs.mkdirSync(bad);
	await assert.rejects(cleanSubFiles("current", ""), /Cannot inspect session/);
	assert.ok(fs.existsSync(orphan));
});

test("conflicting or invalid ownership aborts cleanup rather than reassigning a Sub", async () => {
	const orphan = sub("gone");
	const invalid = session(`sub-${randomUUID()}`, root, undefined, { id: "gone" });
	invalid.appendCustomEntry(SUB_OWNER_ENTRY, { version: 1, subSessionId: invalid.getSessionId(), mainSessionId: "another-main" });
	await assert.rejects(cleanSubFiles("current", ""), /Conflicting Sub session owners/);
	assert.ok(fs.existsSync(orphan));
	assert.ok(fs.existsSync(invalid.getSessionFile()!));
});

test("linked session files and runtime children are never deletion targets", async () => {
	const outside = path.join(root, "keep");
	fs.mkdirSync(outside);
	fs.writeFileSync(path.join(outside, "important"), "keep");
	const native = session("anchor").getSessionDir();
	const file = sub("gone", root, outside);
	const linked = path.join(native, "linked.jsonl");
	fs.symlinkSync(file, linked);
	fs.mkdirSync(runtimeRoot(), { recursive: true });
	fs.symlinkSync(outside, path.join(runtimeRoot(), "linked-main"), "dir");
	const orphan = channel("gone");
	fs.symlinkSync(outside, path.join(orphan, "linked"), "dir");
	assert.deepEqual(await cleanSubFiles("current", ""), { removed: 0, removedChannels: 1, errors: [] });
	assert.ok(fs.lstatSync(linked).isSymbolicLink());
	assert.ok(fs.existsSync(file));
	assert.equal(fs.readFileSync(path.join(outside, "important"), "utf8"), "keep");
});

test("a linked runtime root aborts cleanup before session deletion", async () => {
	const orphan = sub("gone");
	const outside = path.join(root, "outside");
	fs.mkdirSync(outside);
	fs.mkdirSync(path.dirname(runtimeRoot()), { recursive: true });
	fs.symlinkSync(outside, runtimeRoot(), "dir");
	fs.mkdirSync(path.join(outside, "keep"));
	await assert.rejects(cleanSubFiles("current", ""), /symlinked directory/);
	assert.ok(fs.existsSync(orphan));
});

test("empty stores are a no-op and do not create directories", async () => {
	assert.deepEqual(await cleanSubFiles("current", ""), { removed: 0, removedChannels: 0, errors: [] });
	assert.equal(fs.existsSync(path.join(root, "agent")), false);
	assert.equal(fs.existsSync(runtimeRoot()), false);
});

function extensionFixture(owningMainId?: string) {
	let command: { handler: (args: string, ctx: ExtensionCommandContext) => unknown } | undefined;
	let shutdown: (event: { reason: string }, ctx: ExtensionCommandContext) => unknown;
	const notifications: string[] = [];
	const pi = {
		registerCommand: (name: string, value: typeof command) => { assert.equal(name, "clean-sub"); command = value; },
		on: (event: string, handler: typeof shutdown) => { assert.equal(event, "session_shutdown"); shutdown = handler; },
	} as unknown as ExtensionAPI;
	registerCleanSubCommand(pi, owningMainId);
	const ctx = {
		cwd: root, sessionManager: { getSessionId: () => "current", getSessionDir: () => "" },
		ui: { notify: (message: string) => notifications.push(message) },
	} as unknown as ExtensionCommandContext;
	return { command: () => command!.handler("", ctx), shutdown: (reason: string) => shutdown({ reason }, ctx), notifications };
}

test("/clean-sub runs globally without confirmation or a model turn", async () => {
	const extension = extensionFixture();
	const local = sub("gone");
	const other = sub("gone", path.join(root, "other"));
	await extension.command();
	assert.equal(fs.existsSync(local), false);
	assert.equal(fs.existsSync(other), false);
	assert.match(extension.notifications[0]!, /Removed 2 orphaned Sub sessions/);
});

test("only quit triggers automatic local cleanup; other shutdown reasons leave files alone", async () => {
	const extension = extensionFixture();
	const local = sub("gone");
	const other = sub("gone", path.join(root, "other"));
	for (const reason of ["reload", "new", "resume", "fork"]) {
		await extension.shutdown(reason);
		assert.ok(fs.existsSync(local));
	}
	await extension.shutdown("quit");
	assert.equal(fs.existsSync(local), false);
	assert.ok(fs.existsSync(other));
	assert.deepEqual(extension.notifications, [], "Successful quit cleanup is silent");
});

test("Sub quit cleanup protects its owning Main even when the Main is still unsaved", async () => {
	const extension = extensionFixture("unsaved-main");
	const own = sub("unsaved-main");
	const ownChannel = channel("unsaved-main");
	const orphan = sub("gone");
	await extension.shutdown("quit");
	assert.ok(fs.existsSync(own));
	assert.ok(fs.existsSync(ownChannel));
	assert.equal(fs.existsSync(orphan), false);
});

test("cleanup errors are reported without preventing shutdown", async () => {
	const extension = extensionFixture();
	const bad = session("corrupt").getSessionFile()!;
	fs.writeFileSync(bad, "{broken");
	await extension.shutdown("quit");
	assert.match(extension.notifications[0]!, /cleanup aborted/);
});
