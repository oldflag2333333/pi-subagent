import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createAssistantMessageEventStream, getCurrentSystemMessage, type AssistantMessage, type ToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createChannel, listTalkToMain, listTalkToSub, readSubClosed, talkToSub } from "../src/channel.js";
import { registerSub } from "../src/tools/sub.js";

let root: string;
let previous: Record<string, string | undefined>;
let session: AgentSession | undefined;
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-talk-sdk-"));
	previous = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_SUBAGENT_CHANNEL", "PI_SUBAGENT_TOKEN", "XDG_RUNTIME_DIR"].map((key) => [key, process.env[key]]));
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
	process.env.XDG_RUNTIME_DIR = root;
});
afterEach(async () => {
	try {
		await session?.abort();
		await session?.extensionRunner?.emit({ type: "session_shutdown", reason: "reload" });
		session?.dispose();
	} finally {
		session = undefined;
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
});

interface ScriptedCall {
	name: "talk" | "perform_work";
	arguments: ToolCall["arguments"];
}

async function fixture(calls: ScriptedCall[]) {
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir);
	const channel = createChannel({ runId: "talk-sub", mainSessionId: "main", title: "Worker", task: "Perform work", cwd: root,
		profile: { version: 1, name: "worker", tools: ["perform_work"], source: "global", sourcePath: "/tmp/worker.json", resolvedSkills: [], resolvedExtensions: [] },
	});
	process.env.PI_SUBAGENT_CHANNEL = channel.channelDir;
	process.env.PI_SUBAGENT_TOKEN = channel.token;
	const requests: TranscriptContext[] = [];
	const errors: unknown[] = [];
	let workCount = 0;
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
		extensionFactories: [(pi) => {
			pi.registerProvider("talk-fixture", {
				api: "talk-fixture-api", apiKey: "fixture-only", baseUrl: "https://fixture.invalid",
				models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
				streamSimple: (model, context) => {
					const call = calls[requests.length];
					requests.push(structuredClone(context));
					const stream = createAssistantMessageEventStream();
					const message: AssistantMessage = {
						role: "assistant", api: model.api, provider: model.provider, model: model.id,
						content: call ? [{ type: "toolCall", id: `call-${requests.length}`, ...call }] : [{ type: "text", text: "Done" }],
						stopReason: call ? "toolUse" : "stop", timestamp: Date.now(),
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					};
					stream.push({ type: "start", partial: structuredClone(message) });
					stream.push({ type: "done", reason: call ? "toolUse" : "stop", message });
					stream.end(message);
					return stream;
				},
			});
			pi.registerTool({ name: "perform_work", label: "Perform work", description: "Perform the next task step", parameters: Type.Object({}),
				execute: async () => {
					workCount++;
					return { content: [{ type: "text", text: "Work completed" }], details: undefined };
				},
			});
			registerSub(pi);
		}],
	});
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	({ session } = await createAgentSession({ cwd: root, agentDir, resourceLoader, settingsManager, modelRuntime, sessionManager: SessionManager.inMemory(root), tools: ["perform_work", "talk"] }));
	await session.bindExtensions({ onError: (error) => errors.push(error) });
	const model = modelRuntime.getModel("talk-fixture", "fixture");
	assert.ok(model);
	await session.setModel(model);
	return { channel, requests, errors, workCount: () => workCount };
}

for (const endTurn of [undefined, false, true]) {
	test(`Sub talk endTurn=${String(endTurn)} ${endTurn ? "ends the run" : "continues working without a Main reply"}`, async () => {
		const message = endTurn ? "Need a decision before proceeding." : "Preflight complete; continuing work.";
		const work: ScriptedCall = { name: "perform_work", arguments: {} };
		const delivery: ScriptedCall = { name: "talk", arguments: { message: "Work finished.", endTurn: true } };
		const calls: ScriptedCall[] = [
			{ name: "talk", arguments: { message, ...(endTurn === undefined ? {} : { endTurn }) } },
			work, delivery,
		];
		const f = await fixture(calls);
		const sessionId = session!.sessionManager.getSessionId();
		await session!.prompt("Perform the task and report progress and completion through talk.");
		assert.equal(f.requests.length, endTurn ? 1 : 3, "Only explicit endTurn should skip the next model request");
		assert.equal(f.workCount(), endTurn ? 0 : 1);
		assert.deepEqual(listTalkToMain(f.channel.channelDir, f.channel).map((item) => item.message), endTurn ? [message] : [message, "Work finished."]);
		assert.equal(readSubClosed(f.channel.channelDir, f.channel), undefined, "Ending a turn must not close the Sub");
		assert.equal(session!.sessionManager.getSessionId(), sessionId);
		const protocol = getCurrentSystemMessage(f.requests[0]!.messages)?.sections?.subagent_sub_protocol ?? "";
		assert.match(protocol, /endTurn=true/);
		assert.match(protocol, /progress update.*continue/i);

		// A normal Main follow-up must still wake the same Sub after explicit termination.
		if (!endTurn) calls.push(work, delivery);
		talkToSub(f.channel.channelDir, f.channel, "Continue with the next task step.");
		const expectedRequests = endTurn ? 3 : 5;
		const deadline = Date.now() + 7000;
		while ((f.requests.length < expectedRequests || listTalkToSub(f.channel.channelDir, f.channel).length > 0) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		await session!.waitForIdle();
		assert.equal(f.requests.length, expectedRequests);
		assert.equal(f.workCount(), endTurn ? 1 : 2);
		assert.deepEqual(listTalkToSub(f.channel.channelDir, f.channel), []);
		assert.equal(readSubClosed(f.channel.channelDir, f.channel), undefined);
		assert.equal(session!.sessionManager.getSessionId(), sessionId);
		assert.deepEqual(f.errors, []);
	});
}
