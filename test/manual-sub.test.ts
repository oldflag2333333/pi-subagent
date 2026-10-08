import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { listTalkToSub, readManifest, talkToMain, writeSubClosed, writeSubSessionInfo } from "../src/channel.js";
import { MANUAL_MAIN_GUIDANCE } from "../src/manual-context.js";
import { MainRunManager } from "../src/run-manager.js";
import { listResumableSubSessions } from "../src/sessions.js";
import type { ResolvedProfile } from "../src/profiles/types.js";

let root: string;
let previous: Record<string, string | undefined>;
const managers: MainRunManager[] = [];
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "facets-manual-sub-"));
	previous = Object.fromEntries(["PI_CODING_AGENT_DIR", "XDG_RUNTIME_DIR", "HERDR_ENV", "HERDR_WORKSPACE_ID"].map((key) => [key, process.env[key]]));
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
	process.env.XDG_RUNTIME_DIR = root;
	process.env.HERDR_ENV = "1";
	process.env.HERDR_WORKSPACE_ID = "workspace";
});
afterEach(() => {
	for (const manager of managers.splice(0)) manager.shutdown();
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
	fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const profile: ResolvedProfile = { version: 1, name: "review", invocation: "manual", description: "Review a user-specified MR, not architecture consulting", sessionPersistence: "persistent", tools: ["read"], source: "global", sourcePath: "/tmp/review.json", resolvedSkills: [], resolvedExtensions: [] };
	const starts: Array<{ args: string[]; session: SessionManager }> = [];
	const sessions = new Map<string, SessionManager>();
	let channelDir = "";
	let status = "idle";
	let gone = false;
	const exec = async (_command: string, args: string[]) => {
		let payload: unknown = {};
		if (args[0] === "tab" && args[1] === "create") {
			channelDir = args.find((arg) => arg.startsWith("PI_FACETS_CHANNEL="))!.slice("PI_FACETS_CHANNEL=".length);
			payload = { tab: { tab_id: "tab" }, root_pane: { pane_id: "pane" } };
		}
		if (args[0] === "tab" && args[1] === "get") {
			return gone ? { code: 1, killed: false, stdout: JSON.stringify({ error: { code: "tab_not_found" } }), stderr: "" }
				: { code: 0, killed: false, stdout: JSON.stringify({ result: { tab: { tab_id: "tab" } } }), stderr: "" };
		}
		if (args[0] === "agent" && args[1] === "start") {
			gone = false;
			const resumeIndex = args.indexOf("--session");
			const sub = resumeIndex >= 0 ? sessions.get(args[resumeIndex + 1]!)! : SessionManager.create(root);
			assert.ok(sub);
			sub.appendSessionInfo(args[args.indexOf("--name") + 1]!);
			sub.appendMessage({ role: "user", content: "Fixture Sub task", timestamp: Date.now() });
			sessions.set(sub.getSessionId(), sub);
			writeSubSessionInfo(channelDir, readManifest(channelDir), { sessionId: sub.getSessionId(), sessionFile: sub.getSessionFile()! });
			starts.push({ args, session: sub });
		}
		if (args[0] === "agent" && args[1] === "get") payload = { agent: { pane_id: "pane", tab_id: "tab", agent_status: gone ? "unknown" : status } };
		return { code: 0, killed: false, stdout: JSON.stringify(payload), stderr: "" };
	};
	const attach = (main = SessionManager.create(root)) => {
		if (main.getEntries().length === 0) main.appendMessage({ role: "user", content: "Main coding task", timestamp: Date.now() });
		const delivered: string[] = [];
		const pi = {
			on: () => () => {}, exec,
			appendEntry: (type: string, data: unknown) => main.appendCustomEntry(type, data),
			sendUserMessage: (content: string) => { delivered.push(content); main.appendMessage({ role: "user", content, timestamp: Date.now() }); },
		} as unknown as ExtensionAPI;
		const ctx = { cwd: root, model: {}, sessionManager: main, isIdle: () => true, isProjectTrusted: () => true, hasUI: true, ui: { notify: () => {} } } as unknown as ExtensionContext;
		const manager = new MainRunManager(pi);
		managers.push(manager);
		manager.start(ctx);
		const invoke = (task = "Review MR 42") => manager.invokeProfile({ profile, cwd: root, task });
		return { manager, main, ctx, pi, delivered, invoke };
	};
	return { profile, starts, attach, gone: () => { gone = true; }, status: (value: string) => { status = value; } };
}

test("manual invocations serialize creation, reuse busy Subs, and survive Main reload", async () => {
	const f = fixture();
	const first = f.attach();
	const [created, queued] = await Promise.all([first.invoke("First review"), first.invoke("Follow-up review")]);
	assert.equal(created.action, "created");
	assert.equal(queued.action, "queued");
	assert.equal(created.run.subSessionId, queued.run.subSessionId);
	assert.equal(f.starts.length, 1);
	assert.equal(readManifest(created.run.channelDir).origin, "manual");
	assert.ok(f.starts[0]!.args.includes("[sub:manual] review"));
	assert.match(listTalkToSub(created.run.channelDir, readManifest(created.run.channelDir))[0]!.message, /Follow-up review/);
	first.manager.shutdown();
	const reloaded = f.attach(SessionManager.open(first.main.getSessionFile()!));
	f.status("working");
	const again = await reloaded.invoke();
	assert.equal(again.action, "queued");
	assert.equal(again.run.runId, created.run.runId);
	assert.equal(f.starts.length, 1);
	assert.equal((await reloaded.manager.subs()).open[0]!.run.origin, "manual");
});

test("closed persistent profiles resume the exact session after Main restart", async () => {
	const f = fixture();
	const first = f.attach();
	const created = await first.invoke();
	await first.manager.close(created.run.runId, "Review accepted");
	assert.equal(fs.existsSync(created.run.channelDir), false);
	assert.deepEqual(await listResumableSubSessions(), [], "Do not advertise manual specialists to other Mains");
	const closed = (await first.manager.subs()).resumable;
	assert.equal(closed[0]?.sessionId, created.run.subSessionId);
	assert.equal(closed[0]?.origin, "manual");
	first.manager.shutdown();
	const restarted = f.attach(SessionManager.open(first.main.getSessionFile()!));
	const resumed = await restarted.invoke("Review MR 43");
	assert.equal(resumed.action, "resumed");
	assert.notEqual(resumed.run.runId, created.run.runId);
	assert.equal(resumed.run.subSessionId, created.run.subSessionId);
	assert.equal(f.starts.length, 2);
	assert.equal(f.starts[1]!.args[f.starts[1]!.args.indexOf("--session") + 1], created.run.subSessionId);
});

test("manual tab closure retains pending results and their specialist routing guidance", async () => {
	const f = fixture();
	const main = f.attach();
	const { run } = await main.invoke();
	const manifest = readManifest(run.channelDir);
	talkToMain(run.channelDir, manifest, "Review findings");
	writeSubClosed(run.channelDir, manifest, "Manual close");
	main.manager.start(main.ctx);
	main.manager.start(main.ctx);
	assert.equal(main.delivered.length, 1);
	assert.match(main.delivered[0]!, /User-invoked specialist: review/);
	assert.ok(main.delivered[0]!.includes(MANUAL_MAIN_GUIDANCE));
	assert.ok(main.delivered[0]!.includes(f.profile.description!));
	assert.equal((await main.invoke()).run.subSessionId, run.subSessionId);
});

test("different Main sessions and forks do not inherit manual specialist bindings", async () => {
	const f = fixture();
	const first = f.attach();
	const created = await first.invoke();
	const second = f.attach();
	assert.deepEqual(await second.manager.subs(), { open: [], resumable: [] });
	const other = await second.invoke();
	assert.notEqual(other.run.subSessionId, created.run.subSessionId);
	const forkSession = SessionManager.inMemory(root, undefined, first.main.getEntries());
	assert.notEqual(forkSession.getSessionId(), first.main.getSessionId());
	const fork = f.attach(forkSession);
	assert.deepEqual(await fork.manager.subs(), { open: [], resumable: [] });
	const forked = await fork.invoke();
	assert.notEqual(forked.run.subSessionId, created.run.subSessionId);
});

test("reusing an open manual Sub works at the open-Sub limit", async () => {
	const f = fixture();
	const main = f.attach();
	const { run } = await main.invoke();
	for (let index = 0; index < 3; index++) {
		main.manager.runs.set("other-" + index, { ...run, runId: "other-" + index, origin: undefined, profileName: "oracle" });
	}
	assert.equal((await main.invoke()).action, "queued");
	await assert.rejects(main.manager.invokeProfile({ profile: { ...f.profile, name: "another" }, cwd: root, task: "New task" }), /at most 4/);
	assert.equal(f.starts.length, 1);
});

test("a command queued before Main shutdown cannot launch into a replacement runtime", async () => {
	const f = fixture();
	const main = f.attach();
	const pending = main.invoke();
	main.manager.shutdown();
	await assert.rejects(pending, /abort/i);
	assert.equal(f.starts.length, 0);
	main.manager.start(main.ctx);
	assert.equal((await main.invoke()).action, "created");
});

test("missing saved sessions and uncertain live status never silently create replacements", async () => {
	const f = fixture();
	const main = f.attach();
	const { run } = await main.invoke();
	f.status("unknown");
	await assert.rejects(main.invoke(), /Cannot verify/);
	assert.equal(f.starts.length, 1);
	await main.manager.close(run.runId, "Closed");
	fs.rmSync(run.subSessionFile!);
	await assert.rejects(main.invoke(), /No persistent Sub session/);
	assert.equal(f.starts.length, 1);
});

test("abrupt tab closure without a channel marker resumes the same persistent session", async () => {
	const f = fixture();
	const main = f.attach();
	const { run } = await main.invoke();
	f.gone();
	const resumed = await main.invoke();
	assert.equal(resumed.action, "resumed");
	assert.equal(resumed.run.subSessionId, run.subSessionId);
});

test("lost runtime channels are recovered only after Herdr confirms tab closure", async () => {
	const f = fixture();
	const main = f.attach();
	const { run } = await main.invoke();
	fs.rmSync(run.channelDir, { recursive: true });
	await assert.rejects(main.invoke(), /not confirmed closed/);
	f.gone();
	assert.equal((await main.invoke()).run.subSessionId, run.subSessionId);
});

test("model delegation cannot start manual profiles or resume their sessions under another profile", async () => {
	const f = fixture();
	const main = f.attach();
	await assert.rejects(main.manager.delegate({ profile: f.profile, cwd: root, title: "review", task: "Unsolicited" }), /user-invoked only/);
	const { run } = await main.invoke();
	await main.manager.close(run.runId, "Done");
	await assert.rejects(main.manager.delegate({ profile: { ...f.profile, invocation: "both" }, cwd: root, title: "review", task: "Unsolicited", resumeSessionId: run.subSessionId }), /No persistent Sub session/);
	assert.equal(f.starts.length, 1);
});
