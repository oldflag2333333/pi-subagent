import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HerdrLaunchCleanupError, HerdrTabAdapter } from "../src/adapters/herdr.js";
import type { SubLaunchSpec } from "../src/types.js";

const spec: SubLaunchSpec = {
	runId: "12345678-abcd-4000-8000-123456789abc",
	mainSessionId: "main-session-1",
	title: "Research status",
	task: "Research this topic and summarize it.",
	cwd: "/tmp/project",
	projectTrusted: true,
	resumeSessionId: "session-to-resume",
	channelDir: "/tmp/channel",
	token: "token",
	entryPath: "/tmp/facets.ts",
	profile: {
		version: 1,
		name: "research",
		sessionPersistence: "persistent",
		tools: ["web_search"],
		source: "global",
		sourcePath: "/tmp/research.json",
		resolvedSkills: [],
		resolvedExtensions: ["/tmp/web.ts"],
	},
};

test("reads live agent status by pane and does not guess on errors or mismatches", async () => {
	let stdout = JSON.stringify({ result: { agent: { pane_id: "w1:p2", tab_id: "w1:t2", agent_status: "working" } } });
	let code = 0;
	const calls: string[][] = [];
	const pi = { exec: async (_command: string, args: string[]) => {
		calls.push(args);
		return { code, stdout, stderr: "", killed: false };
	} } as unknown as ExtensionAPI;
	const adapter = new HerdrTabAdapter(pi);
	const handle = { adapter: "herdr" as const, paneId: "w1:p2", tabId: "w1:t2" };
	assert.equal(await adapter.status(handle), "working");
	assert.deepEqual(calls, [["agent", "get", "w1:p2"]]);
	for (const status of ["idle", "blocked"] as const) {
		stdout = JSON.stringify({ result: { agent: { pane_id: "w1:p2", tab_id: "w1:t2", agent_status: status } } });
		assert.equal(await adapter.status(handle), status);
	}
	stdout = JSON.stringify({ result: { agent: { pane_id: "w1:p3", tab_id: "w1:t2", agent_status: "working" } } });
	assert.equal(await adapter.status(handle), "unknown");
	stdout = "not json";
	assert.equal(await adapter.status(handle), "unknown");
	code = 1;
	assert.equal(await adapter.status(handle), "unknown");
	assert.equal(await adapter.status(undefined), "unknown");
});

test("rolls back every post-creation failure without reusing the cancelled signal", async (t) => {
	const previous = process.env.HERDR_WORKSPACE_ID;
	process.env.HERDR_WORKSPACE_ID = "w1";
	try {
		for (const stage of ["start", "report-metadata", "prompt"]) {
			for (const failure of ["exit", "throw", "killed", "abort"]) {
				await t.test(`${stage}: ${failure}`, async () => {
					const calls: Array<{ args: string[]; signal?: AbortSignal }> = [];
					const controller = new AbortController();
					const pi = { exec: async (_command: string, args: string[], options: { signal?: AbortSignal }) => {
						calls.push({ args, signal: options.signal });
						if (args[1] === "create") return { code: 0, stdout: JSON.stringify({ tab: { tab_id: "tab" }, root_pane: { pane_id: "pane" } }), stderr: "", killed: false };
						if (args[1] === stage) {
							if (failure === "throw") throw new Error("Process failed");
							if (failure === "abort") controller.abort(new Error("Cancelled"));
							return { code: failure === "exit" ? 1 : 0, stdout: "{}", stderr: failure === "abort" ? "" : "Process failed", killed: failure === "killed" };
						}
						return { code: 0, stdout: "{}", stderr: "", killed: false };
					} } as unknown as ExtensionAPI;
					await assert.rejects(() => new HerdrTabAdapter(pi).launch(spec, controller.signal), /Process failed|Cancelled/);
					assert.deepEqual(calls.at(-1), { args: ["tab", "close", "tab"], signal: undefined });
					assert.equal(calls.filter((call) => call.args[1] === "close").length, 1);
				});
			}
		}
	} finally {
		if (previous === undefined) delete process.env.HERDR_WORKSPACE_ID;
		else process.env.HERDR_WORKSPACE_ID = previous;
	}
});

test("handles cancellation during creation, missing pane IDs, and failed creation with a recoverable tab ID", async () => {
	const previous = process.env.HERDR_WORKSPACE_ID;
	process.env.HERDR_WORKSPACE_ID = "w1";
	try {
		for (const mode of ["cancel", "missing-pane", "failed-create"]) {
			const controller = new AbortController();
			const calls: string[][] = [];
			const pi = { exec: async (_command: string, args: string[]) => {
				calls.push(args);
				if (args[1] === "create") {
					if (mode === "cancel") controller.abort(new Error("Cancelled during creation"));
					return { code: mode === "failed-create" ? 1 : 0, stdout: JSON.stringify({ tab: { tab_id: "tab" }, ...(mode === "missing-pane" ? {} : { root_pane: { pane_id: "pane" } }) }), stderr: "", killed: false };
				}
				return { code: 0, stdout: "{}", stderr: "", killed: false };
			} } as unknown as ExtensionAPI;
			await assert.rejects(() => new HerdrTabAdapter(pi).launch(spec, controller.signal));
			assert.deepEqual(calls, [calls[0], ["tab", "close", "tab"]]);
		}
		const controller = new AbortController();
		controller.abort();
		let called = false;
		const pi = { exec: async () => { called = true; throw new Error("Must not create a tab"); } } as unknown as ExtensionAPI;
		await assert.rejects(() => new HerdrTabAdapter(pi).launch(spec, controller.signal));
		assert.equal(called, false);
	} finally {
		if (previous === undefined) delete process.env.HERDR_WORKSPACE_ID;
		else process.env.HERDR_WORKSPACE_ID = previous;
	}
});

test("returns a recovery handle when both launch and rollback fail", async () => {
	const previous = process.env.HERDR_WORKSPACE_ID;
	process.env.HERDR_WORKSPACE_ID = "w1";
	const pi = { exec: async (_command: string, args: string[]) => {
		if (args[1] === "create") return { code: 0, stdout: JSON.stringify({ tab: { tab_id: "tab" }, root_pane: { pane_id: "pane" } }), stderr: "", killed: false };
		return { code: 1, stdout: "", stderr: args[1] === "close" ? "Close failed" : "Launch failed", killed: false };
	} } as unknown as ExtensionAPI;
	try {
		await assert.rejects(() => new HerdrTabAdapter(pi).launch(spec), (error: unknown) => {
			assert.ok(error instanceof HerdrLaunchCleanupError);
			assert.deepEqual(error.handle, { adapter: "herdr", tabId: "tab", paneId: "pane" });
			assert.match(error.message, /Launch failed.*Close failed/);
			return true;
		});
	} finally {
		if (previous === undefined) delete process.env.HERDR_WORKSPACE_ID;
		else process.env.HERDR_WORKSPACE_ID = previous;
	}
});

test("tab existence distinguishes confirmed closure from Herdr failures", async () => {
	for (const [response, expected] of [
		[{ code: 0, stdout: JSON.stringify({ result: { tab: { tab_id: "tab" } } }) }, true],
		[{ code: 1, stdout: JSON.stringify({ error: { code: "tab_not_found" } }) }, false],
		[{ code: 1, stdout: JSON.stringify({ error: { code: "server_unavailable" } }) }, undefined],
		[{ code: 1, stdout: "" }, undefined],
		[{ code: 0, stdout: JSON.stringify({ result: { tab: { tab_id: "different" } } }) }, undefined],
	] as const) {
		const pi = { exec: async () => ({ ...response, killed: false, stderr: "" }) } as unknown as ExtensionAPI;
		assert.equal(await new HerdrTabAdapter(pi).exists({ adapter: "herdr", tabId: "tab" }), expected);
	}
});

test("close reports command failure instead of claiming success", async () => {
	for (const failure of [{ code: 1, killed: false }, { code: 0, killed: true }]) {
		const pi = { exec: async () => ({ ...failure, stdout: "", stderr: "Close failed" }) } as unknown as ExtensionAPI;
		await assert.rejects(() => new HerdrTabAdapter(pi).close({ adapter: "herdr", tabId: "tab" }), /Close failed/);
	}
});

test("starts an idle Pi before submitting work through herdr agent prompt", async () => {
	const previousEnvironment = process.env.HERDR_ENV;
	const previousWorkspace = process.env.HERDR_WORKSPACE_ID;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-facets-herdr-"));
	const integration = path.join(agentDir, "extensions", "herdr-agent-state.ts");
	fs.mkdirSync(path.dirname(integration), { recursive: true });
	fs.writeFileSync(integration, "export default () => {}\n");
	process.env.HERDR_ENV = "1";
	process.env.HERDR_WORKSPACE_ID = "w1";
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const calls: Array<{ command: string; args: string[] }> = [];
	const fakePi = {
		exec: async (command: string, args: string[]) => {
			calls.push({ command, args });
			if (args[0] === "tab" && args[1] === "create") {
				return { code: 0, stdout: JSON.stringify({ result: { tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p2" } } }), stderr: "", killed: false };
			}
			return { code: 0, stdout: "{}", stderr: "", killed: false };
		},
	} as unknown as ExtensionAPI;
	try {
		const handle = await new HerdrTabAdapter(fakePi).launch(spec);
		assert.deepEqual(handle, { adapter: "herdr", tabId: "w1:t2", paneId: "w1:p2" });
		const start = calls.find((call) => call.args[0] === "agent" && call.args[1] === "start");
		const prompt = calls.find((call) => call.args[0] === "agent" && call.args[1] === "prompt");
		assert.ok(start);
		assert.ok(prompt);
		const metadata = calls.find((call) => call.args[0] === "pane" && call.args[1] === "report-metadata");
		assert.equal(start.args.includes(spec.task), false);
		assert.equal(start.args.includes(integration), true);
		assert.equal(start.args.includes("--no-session"), false);
		assert.deepEqual(start.args.slice(start.args.indexOf("--session"), start.args.indexOf("--session") + 2), ["--session", "session-to-resume"]);
		assert.equal(start.args.includes("--approve"), true);
		assert.equal(start.args.includes("--no-approve"), false);
		assert.ok(metadata);
		assert.equal(metadata.args.includes("facets_role=sub"), true);
		assert.equal(metadata.args.includes("facets_main_session=main-session-1"), true);
		assert.equal(prompt.args.includes(spec.task), true);
		assert.ok(calls.indexOf(start) < calls.indexOf(metadata));
		assert.ok(calls.indexOf(metadata) < calls.indexOf(prompt));
	} finally {
		if (previousEnvironment === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = previousEnvironment;
		if (previousWorkspace === undefined) delete process.env.HERDR_WORKSPACE_ID;
		else process.env.HERDR_WORKSPACE_ID = previousWorkspace;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});
