import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream, getCurrentSystemMessage, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createChannel, listTalkToMain, listTalkToSub, readManifest, talkToMain, talkToSub, writeSubClosed } from "../src/channel.js";
import { MainRunManager } from "../src/run-manager.js";
import { MainContextRuntime } from "../src/main-context.js";
import { StartupProfileRuntime } from "../src/profiles/runtime.js";
import { readTalkReceipt } from "../src/talk-message.js";

function registerFixtureModel(pi: ExtensionAPI, requests: TranscriptContext[]) {
	pi.registerProvider("facets-context-fixture", {
		api: "facets-context-fixture-api", apiKey: "fixture-only", baseUrl: "https://fixture.invalid",
		models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple: (model, context) => {
			requests.push(structuredClone(context));
			const stream = createAssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], stopReason: "pending", timestamp: Date.now(),
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			};
			stream.push({ type: "start", partial: structuredClone(message) });
			message.content.push({ type: "text", text: "" });
			stream.push({ type: "text_start", contentIndex: 0, partial: structuredClone(message) });
			message.content = [{ type: "text", text: "ok" }];
			stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: structuredClone(message) });
			stream.push({ type: "text_end", contentIndex: 0, content: "ok", partial: structuredClone(message) });
			message.stopReason = "stop";
			stream.push({ type: "done", reason: "stop", message });
			stream.end(message);
			return stream;
		},
	});
}

async function contextSession(root: string, requests: TranscriptContext[], factory: (pi: ExtensionAPI) => void, flag?: string, tools = ["read"]) {
	const agentDir = path.join(root, "agent");
	const skill = path.join(agentDir, "skills", "fixture-skill", "SKILL.md");
	fs.mkdirSync(path.dirname(skill), { recursive: true });
	fs.writeFileSync(skill, "---\nname: fixture-skill\ndescription: Native fixture skill\n---\nSkill body.\n");
	const promptHooks: string[] = [];
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd: root, agentDir, settingsManager,
		noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
		additionalSkillPaths: [skill], appendSystemPrompt: ["Native addendum."],
		agentsFilesOverride: () => ({ agentsFiles: [{ path: path.join(root, "AGENTS.md"), content: "Native project rule." }] }),
		extensionFactories: [(pi) => {
			registerFixtureModel(pi, requests);
			factory(pi);
			pi.on("before_agent_start", (event) => { promptHooks.push(event.prompt); });
		}],
	});
	await resourceLoader.reload();
	if (flag) resourceLoader.getExtensions().runtime.flagValues.set("profile", flag);
	const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	const { session } = await createAgentSession({ cwd: root, agentDir, resourceLoader, settingsManager, modelRuntime, sessionManager: SessionManager.inMemory(root), tools });
	const errors: unknown[] = [];
	await session.bindExtensions({ onError: (error) => errors.push(error) });
	if (!session.model || session.model.provider !== "facets-context-fixture") {
		const fixture = modelRuntime.getModel("facets-context-fixture", "fixture");
		assert.ok(fixture);
		await session.setModel(fixture);
	}
	return { session, errors, promptHooks };
}

function assertNativeSections(context: TranscriptContext) {
	const current = getCurrentSystemMessage(context.messages);
	assert.ok(current?.sections);
	assert.match(current.sections.preamble!, /expert coding assistant/);
	assert.match(current.sections.tools!, /read/);
	assert.match(current.sections.rules!, /Be concise/);
	assert.match(current.sections.docs!, /Pi documentation/);
	assert.match(current.sections.addendum!, /Native addendum/);
	assert.match(current.sections.project_context!, /Native project rule/);
	assert.match(current.sections.skills!, /fixture-skill/);
	assert.ok(current.sections.cwd);
	return current.sections;
}

test("Main uses native prompt assembly and persists only changed Facets sections after reload", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "facets-context-main-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
	const profileDir = path.join(root, "agent", "facets", "profiles");
	fs.mkdirSync(profileDir, { recursive: true });
	fs.writeFileSync(path.join(profileDir, "reviewer.json"), JSON.stringify({ version: 1, name: "reviewer", tools: ["read"], instructions: "You are a specialized reviewer." }));
	const mainFile = path.join(root, "agent", "facets", "MAIN.md");
	fs.writeFileSync(mainFile, "Route review tasks to the reviewer.");
	const requests: TranscriptContext[] = [];
	let fixture: Awaited<ReturnType<typeof contextSession>> | undefined;
	try {
		fixture = await contextSession(root, requests, (pi) => {
			new StartupProfileRuntime(pi).register();
			new MainContextRuntime(pi).register();
		}, "reviewer");
		await fixture.session.prompt("First request");
		const initial = assertNativeSections(requests[0]!);
		assert.match(initial.facets_profile!, /specialized reviewer/);
		assert.match(initial.facets_profiles!, /reviewer/);
		assert.match(initial.facets_main!, /Route review tasks/);
		assert.equal(initial.facets_sub_protocol, undefined);
		const systemEntries = () => fixture!.session.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "system");
		const count = systemEntries().length;
		await fixture.session.prompt("Same configuration");
		assert.equal(systemEntries().length, count, "Unchanged sections must not create repeated prompt updates");
		fs.writeFileSync(mainFile, "Delegate every review task.");
		await fixture.session.reload();
		await fixture.session.prompt("Updated configuration");
		const updated = assertNativeSections(requests[2]!);
		assert.match(updated.facets_main!, /Delegate every review/);
		assert.equal(updated.facets_profile, initial.facets_profile);
		assert.equal(updated.facets_profiles, initial.facets_profiles);
		const last = systemEntries().at(-1)!;
		assert.ok(last.type === "message" && last.message.role === "system");
		assert.deepEqual(Object.keys(last.message.sections ?? {}), ["facets_main"]);
		assert.deepEqual(fixture.errors, []);
	} finally {
		fixture?.session.dispose();
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("Main acknowledges a real SDK delivery only after its session receipt, then drains a closed Sub", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "facets-context-receipt-"));
	const previous = process.env.XDG_RUNTIME_DIR;
	process.env.XDG_RUNTIME_DIR = root;
	const requests: TranscriptContext[] = [];
	let fixture: Awaited<ReturnType<typeof contextSession>> | undefined;
	let manager: MainRunManager | undefined;
	let mainContext: ExtensionContext | undefined;
	try {
		fixture = await contextSession(root, requests, (pi) => {
			manager = new MainRunManager(pi);
			pi.on("session_start", (_event, ctx) => { mainContext = ctx; manager!.start(ctx); });
			pi.on("session_shutdown", () => manager!.shutdown());
		});
		const channel = createChannel({
			runId: "final-delivery", mainSessionId: fixture.session.sessionManager.getSessionId(), title: "Review", task: "Review", cwd: root,
			profile: { version: 1, name: "reviewer", tools: ["read"], source: "global", sourcePath: "/tmp/profile.json", resolvedSkills: [], resolvedExtensions: [] },
		});
		manager!.runs.set(channel.runId, {
			version: 1, runId: channel.runId, mainSessionId: channel.mainSessionId, title: channel.title, cwd: root,
			profileName: "reviewer", sessionPersistence: "ephemeral", channelDir: channel.channelDir,
			createdAt: channel.createdAt, updatedAt: channel.createdAt, surface: { adapter: "herdr", tabId: "closed-tab" },
		});
		const manifest = readManifest(channel.channelDir);
		const incoming = talkToMain(channel.channelDir, manifest, "Final review");
		writeSubClosed(channel.channelDir, manifest, "Manual close");
		manager!.start(mainContext!);
		assert.equal(listTalkToMain(channel.channelDir, manifest).length, 1);
		assert.ok(fs.existsSync(channel.channelDir));
		// User-input preflight awaits hooks before Pi becomes busy.
		await new Promise<void>((resolve) => setImmediate(resolve));
		await fixture.session.waitForIdle();
		const received = fixture.session.sessionManager.getEntries().filter((entry) => entry.type === "message" && readTalkReceipt(entry.message) !== undefined);
		assert.equal(received.length, 1);
		assert.ok(received[0]?.type === "message");
		assert.equal(readTalkReceipt(received[0].message)?.messageId, incoming.id);
		await new Promise<void>((resolve) => setImmediate(resolve));
		t.mock.timers.tick(20);
		assert.equal(fs.existsSync(channel.channelDir), false);
		t.mock.timers.tick(800);
		assert.equal(requests.length, 1);
		assert.equal(fixture.promptHooks.length, 1, "Idle talk must use normal prompt assembly");
		assert.deepEqual(fixture.errors, []);
	} finally {
		manager?.shutdown();
		fixture?.session.dispose();
		if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
		else process.env.XDG_RUNTIME_DIR = previous;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("Sub retains native context and adds only its own instructions and protocol", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "facets-context-sub-"));
	const previous = { agent: process.env.PI_CODING_AGENT_DIR, role: process.env.PI_FACETS_ROLE, channel: process.env.PI_FACETS_CHANNEL, token: process.env.PI_FACETS_TOKEN, runtime: process.env.XDG_RUNTIME_DIR };
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
	process.env.XDG_RUNTIME_DIR = root;
	const mainDir = path.join(root, "agent", "facets");
	fs.mkdirSync(mainDir, { recursive: true });
	fs.writeFileSync(path.join(mainDir, "MAIN.md"), "Main-only instructions must not leak.");
	const channel = createChannel({ origin: "manual", runId: "context-sub", mainSessionId: "main", title: "Review", task: "Review", cwd: root,
		profile: { version: 1, name: "reviewer", tools: ["read"], instructions: "Sub-specific role.", source: "global", sourcePath: "/tmp/reviewer.json", resolvedSkills: [], resolvedExtensions: [] },
	});
	process.env.PI_FACETS_ROLE = "sub";
	process.env.PI_FACETS_CHANNEL = channel.channelDir;
	process.env.PI_FACETS_TOKEN = channel.token;
	const requests: TranscriptContext[] = [];
	let fixture: Awaited<ReturnType<typeof contextSession>> | undefined;
	try {
		const { default: facets } = await import("../src/index.js");
		fixture = await contextSession(root, requests, facets, undefined, ["read", "talk"]);
		assert.ok(fixture.session.getActiveToolNames().includes("talk"));
		const manifest = readManifest(channel.channelDir);
		talkToSub(channel.channelDir, manifest, "Initial task from Main");
		const initialDeadline = Date.now() + 2000;
		while (listTalkToSub(channel.channelDir, manifest).length > 0 && Date.now() < initialDeadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.deepEqual(listTalkToSub(channel.channelDir, manifest), []);
		await fixture.session.waitForIdle();
		assert.equal(fixture.promptHooks.length, 1, "First input via talk must run before_agent_start");
		const sections = assertNativeSections(requests[0]!);
		assert.match(sections.facets_profile!, /Sub-specific role/);
		assert.match(sections.facets_sub_protocol!, /isolated Sub Pi/);
		assert.match(sections.facets_sub_protocol!, /user-invoked specialist session/);
		assert.equal(sections.facets_main, undefined);
		assert.equal(sections.facets_profiles, undefined);
		assert.doesNotMatch(JSON.stringify(sections), /Main-only instructions must not leak/);
		assert.deepEqual(fixture.errors, []);
		await fixture.session.reload();
		const incoming = talkToSub(channel.channelDir, manifest, "Follow-up from Main");
		assert.equal(listTalkToSub(channel.channelDir, manifest).length, 1);
		const deadline = Date.now() + 2000;
		while (listTalkToSub(channel.channelDir, manifest).length > 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		await fixture.session.waitForIdle();
		assert.deepEqual(listTalkToSub(channel.channelDir, manifest), []);
		const received = fixture.session.sessionManager.getEntries().filter((entry) => entry.type === "message" && readTalkReceipt(entry.message) !== undefined);
		assert.equal(received.length, 2);
		assert.ok(received[1]?.type === "message");
		assert.equal(readTalkReceipt(received[1].message)?.messageId, incoming.id);
		assert.equal(fixture.promptHooks.length, 2, "Idle talk after reload must reassemble instructions");
		const followUpSections = assertNativeSections(requests.at(-1)!);
		assert.match(followUpSections.facets_sub_protocol!, /isolated Sub Pi/);
		assert.match(followUpSections.facets_profile!, /Sub-specific role/);
		assert.deepEqual(fixture.errors, []);
	} finally {
		await fixture?.session.extensionRunner?.emit({ type: "session_shutdown", reason: "reload" });
		fixture?.session.dispose();
		for (const [key, value] of Object.entries(previous)) {
			const env = { agent: "PI_CODING_AGENT_DIR", role: "PI_FACETS_ROLE", channel: "PI_FACETS_CHANNEL", token: "PI_FACETS_TOKEN", runtime: "XDG_RUNTIME_DIR" }[key]!;
			if (value === undefined) delete process.env[env]; else process.env[env] = value;
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
});
