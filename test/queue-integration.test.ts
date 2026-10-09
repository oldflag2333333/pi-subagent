import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream, getCurrentSystemMessage, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionContext, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createChannel, MESSAGE_TYPE, readManifest, talkToMain } from "../src/channel.js";
import { bindPromptSections } from "../src/profiles/system-prompt.js";
import { CHANNEL_DEBOUNCE_MS, CHANNEL_RESCAN_MS } from "../src/channel-monitor.js";
import { MainRunManager, RUN_ENTRY } from "../src/run-manager.js";
import { PARENT_WAKE_TEXT } from "../src/parent-wake.js";

async function until(condition: () => boolean): Promise<void> {
	// Native filesystem notifications may be missed; allow the monitor's fallback scan.
	const deadline = Date.now() + CHANNEL_RESCAN_MS + CHANNEL_DEBOUNCE_MS + 2000;
	while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(condition(), "Timed out waiting for queue transition");
}

async function fixture(root: string) {
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir);
	const requests: TranscriptContext[] = [];
	const errors: unknown[] = [];
	const promptHooks: string[] = [];
	const inputSources: string[] = [];
	let instructions = "Fixture role instructions";
	let manager: MainRunManager;
	let context: ExtensionContext;
	let finishFirst: (() => void) | undefined;
	let holdRequest = 1;
	const ui = { notify: () => {}, setStatus: () => {}, setTitle: () => {} } as unknown as ExtensionUIContext;
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
		extensionFactories: [(pi) => {
			pi.registerProvider("queue-fixture", {
				api: "queue-fixture-api", apiKey: "fixture-only", baseUrl: "https://fixture.invalid",
				models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
				streamSimple: (model, value, options) => {
					requests.push(structuredClone(value));
					const stream = createAssistantMessageEventStream();
					let finished = false;
					const finish = (aborted = false) => {
						if (finished) return;
						finished = true;
						const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
							content: [], stopReason: "pending", timestamp: Date.now(),
							usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
						};
						stream.push({ type: "start", partial: structuredClone(message) });
						if (aborted) {
							message.stopReason = "aborted";
							message.errorMessage = "Cancelled";
							stream.push({ type: "error", reason: "aborted", error: message });
						} else {
							message.content = [{ type: "text", text: "" }];
							stream.push({ type: "text_start", contentIndex: 0, partial: structuredClone(message) });
							message.content = [{ type: "text", text: "ok" }];
							stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: structuredClone(message) });
							stream.push({ type: "text_end", contentIndex: 0, content: "ok", partial: structuredClone(message) });
							message.stopReason = "stop";
							stream.push({ type: "done", reason: "stop", message });
						}
						stream.end(message);
					};
					if (requests.length === holdRequest) {
						finishFirst = () => finish();
						options?.signal?.addEventListener("abort", () => finish(true), { once: true });
					} else finish();
					return stream;
				},
			});
			bindPromptSections(pi, ["subagent_fixture"], () => ({ subagent_fixture: instructions }));
			pi.on("before_agent_start", (event) => { promptHooks.push(event.prompt); });
			pi.on("input", (event) => { inputSources.push(event.source); });
			manager = new MainRunManager(pi);
			pi.on("session_start", (_event, ctx) => { context = ctx; manager.start(ctx); });
			pi.on("session_shutdown", () => manager.shutdown());
		}],
	});
	await resourceLoader.reload();
	const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	const { session } = await createAgentSession({ cwd: root, agentDir, resourceLoader, settingsManager, modelRuntime, sessionManager: SessionManager.inMemory(root), tools: ["read"] });
	await session.bindExtensions({ mode: "tui", uiContext: ui, onError: (error) => errors.push(error) });
	const model = modelRuntime.getModel("queue-fixture", "fixture");
	assert.ok(model);
	await session.setModel(model);
	const channel = createChannel({ runId: "run", mainSessionId: session.sessionManager.getSessionId(), title: "Review", task: "Review", cwd: root,
		profile: { version: 1, name: "reviewer", tools: ["read"], source: "global", sourcePath: "/tmp/profile.json", resolvedSkills: [], resolvedExtensions: [] },
	});
	const run = { version: 1 as const, runId: channel.runId, mainSessionId: channel.mainSessionId, title: channel.title, cwd: root, profileName: "reviewer", sessionPersistence: "ephemeral" as const,
		channelDir: channel.channelDir, createdAt: channel.createdAt, updatedAt: channel.createdAt, surface: { adapter: "herdr" as const, tabId: "tab" },
	};
	manager!.runs.set(run.runId, run);
	session.sessionManager.appendCustomEntry(RUN_ENTRY, { ...run });
	manager!.start(context!);
	return { session, channel, requests, errors, promptHooks, inputSources,
		rescan: () => manager.start(context), finish: () => finishFirst!(),
		holdNext: () => { holdRequest = requests.length + 1; },
		setInstructions: (value: string) => { instructions = value; },
		stop: () => manager.shutdown(),
		inboxEntries: () => session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === MESSAGE_TYPE),
	};
}

test("idle talk bursts share one user wake, preserve inbox ordering, and survive reload", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-idle-queue-sdk-"));
	const previous = process.env.XDG_RUNTIME_DIR;
	process.env.XDG_RUNTIME_DIR = root;
	let f: Awaited<ReturnType<typeof fixture>> | undefined;
	try {
		f = await fixture(root);
		const initial = f.session.prompt("Initial Main task");
		await until(() => f!.requests.length === 1);
		f.finish();
		await initial;
		f.holdNext();
		const first = talkToMain(f.channel.channelDir, readManifest(f.channel.channelDir), "First idle delivery");
		const second = talkToMain(f.channel.channelDir, readManifest(f.channel.channelDir), "Second idle delivery");
		f.rescan(); f.rescan();
		await until(() => f!.requests.length === 2);
		assert.deepEqual(f.inputSources, ["interactive", "extension"]);
		assert.deepEqual(f.promptHooks, ["Initial Main task", PARENT_WAKE_TEXT]);
		assert.deepEqual(f.session.getFollowUpMessages(), [], "Custom follow-ups are not user editor input");
		assert.equal(f.inboxEntries().length, 2, "Both inbox cards are appended before the shared wake starts");
		f.finish();
		await until(() => !fs.existsSync(path.join(f!.channel.channelDir, "to-main", second.id + ".json")));
		await f.session.waitForIdle();
		const ids = f.inboxEntries().map((entry) => entry.type === "custom_message" ? (entry.details as { messageId: string }).messageId : undefined);
		assert.deepEqual(ids, [first.id, second.id]);

		f.setInstructions("Updated role after reload");
		await f.session.reload();
		const third = talkToMain(f.channel.channelDir, readManifest(f.channel.channelDir), "/skill:not-a-command");
		f.rescan(); f.rescan();
		await until(() => f!.requests.length === 3 && !fs.existsSync(path.join(f!.channel.channelDir, "to-main", third.id + ".json")));
		await f.session.waitForIdle();
		assert.deepEqual(f.inputSources, ["interactive", "extension", "extension"]);
		assert.equal(f.inboxEntries().length, 3);
		assert.match(JSON.stringify(f.requests[2]!.messages), /\/skill:not-a-command/);
		assert.match(getCurrentSystemMessage(f.requests[2]!.messages)?.sections?.subagent_fixture ?? "", /Updated role after reload/);

		const hooksBeforePrompt = f.promptHooks.length;
		await f.session.prompt("Apply updated configuration");
		assert.equal(f.promptHooks.length, hooksBeforePrompt + 1);
		assert.match(getCurrentSystemMessage(f.requests[3]!.messages)?.sections?.subagent_fixture ?? "", /Updated role after reload/);
		assert.deepEqual(f.errors, []);
	} finally {
		await f?.session.abort();
		f?.stop();
		f?.session.dispose();
		if (previous === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = previous;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("the first idle talk prepares profile sections without any prior user prompt", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-first-wake-sdk-"));
	const previous = process.env.XDG_RUNTIME_DIR;
	process.env.XDG_RUNTIME_DIR = root;
	let f: Awaited<ReturnType<typeof fixture>> | undefined;
	try {
		f = await fixture(root);
		talkToMain(f.channel.channelDir, readManifest(f.channel.channelDir), "First task result");
		f.rescan();
		await until(() => f!.requests.length === 1);
		assert.deepEqual(f.promptHooks, [PARENT_WAKE_TEXT]);
		assert.deepEqual(f.inputSources, ["extension"]);
		assert.equal(f.inboxEntries().length, 1);
		assert.match(getCurrentSystemMessage(f.requests[0]!.messages)?.sections?.subagent_fixture ?? "", /Fixture role instructions/);
		f.finish();
		await f.session.waitForIdle();
		assert.deepEqual(f.errors, []);
	} finally {
		await f?.session.abort();
		f?.stop();
		f?.session.dispose();
		if (previous === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = previous;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

// Regression for Pi #10267/#5581: parentWake enters normal prompt preparation.
test("parentWake preserves profile sections through idle wakes and subsequent busy follow-ups", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-upstream-prompt-"));
	const previous = process.env.XDG_RUNTIME_DIR;
	process.env.XDG_RUNTIME_DIR = root;
	let f: Awaited<ReturnType<typeof fixture>> | undefined;
	try {
		f = await fixture(root);
		const initial = f.session.prompt("Initialize profile");
		await until(() => f!.requests.length === 1);
		f.finish();
		await initial;
		f.holdNext();
		talkToMain(f.channel.channelDir, readManifest(f.channel.channelDir), "Wake while idle");
		f.rescan();
		await until(() => f!.requests.length === 2);
		talkToMain(f.channel.channelDir, readManifest(f.channel.channelDir), "Continue in the same run");
		f.rescan();
		f.finish();
		await until(() => f!.requests.length === 3);
		await f.session.waitForIdle();
		for (const request of f.requests) {
			assert.match(getCurrentSystemMessage(request.messages)?.sections?.subagent_fixture ?? "", /Fixture role instructions/);
		}
	} finally {
		await f?.session.abort();
		f?.stop();
		f?.session.dispose();
		if (previous === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = previous;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

for (const mode of ["reload", "cancel-clear"]) {
	test(`real Pi queue recovery: ${mode}`, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-queue-sdk-"));
		const previous = process.env.XDG_RUNTIME_DIR;
		process.env.XDG_RUNTIME_DIR = root;
		let f: Awaited<ReturnType<typeof fixture>> | undefined;
		let initial: Promise<unknown> | undefined;
		try {
			f = await fixture(root);
			initial = f.session.prompt("Current Main task");
			await until(() => f!.requests.length === 1);
			const message = talkToMain(f.channel.channelDir, readManifest(f.channel.channelDir), "Queued reply from Sub");
			await until(() => f!.session.agent.peekQueuedMessages().some((queued) => queued.role === "custom" && queued.customType === MESSAGE_TYPE && (queued.details as { messageId?: string })?.messageId === message.id));
			const file = path.join(f.channel.channelDir, "to-main", `${message.id}.json`);
			assert.ok(fs.existsSync(file));
			assert.equal(f.inboxEntries().length, 0, "Queued messages are not recorded before the native queue consumes them");
			assert.deepEqual(f.session.getFollowUpMessages(), [], "Talk uses custom follow-ups, not the user-input queue display");
			assert.equal(f.promptHooks.length, 1, "Busy follow-ups reuse the active run rather than starting prompt assembly again");
			assert.deepEqual(f.inputSources, ["interactive"]);
			f.rescan(); f.rescan();
			assert.equal(f.requests.length, 1);
			if (mode === "reload") {
				await f.session.reload();
				f.rescan();
				f.finish();
				await initial;
			} else {
				f.session.clearQueue();
				await f.session.abort();
				await initial;
				f.rescan();
				assert.equal(f.requests.length, 1, "Abort must not immediately restart work or duplicate retained queues");
				await f.session.prompt("Continue manually");
			}
			await until(() => !fs.existsSync(file));
			await f.session.waitForIdle();
			assert.equal(f.inboxEntries().length, 1);
			assert.equal(f.requests.length, mode === "reload" ? 2 : 3);
			for (const request of f.requests) assert.match(getCurrentSystemMessage(request.messages)?.sections?.subagent_fixture ?? "", /Fixture role instructions/);
			assert.deepEqual(f.errors, []);
		} finally {
			await f?.session.abort();
			await initial;
			f?.stop();
			f?.session.dispose();
			if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
			else process.env.XDG_RUNTIME_DIR = previous;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
}
