import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { registerSubCommands } from "../src/commands/sub.js";
import type { MainRunManager } from "../src/run-manager.js";

let root: string;
let previous: string | undefined;
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "facets-manual-commands-"));
	previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
	const profiles = path.join(root, "agent", "facets", "profiles");
	fs.mkdirSync(profiles, { recursive: true });
	for (const name of ["review", "model"]) fs.writeFileSync(path.join(profiles, `${name}.json`), JSON.stringify({ version: 1, name, invocation: "manual", sessionPersistence: "persistent", tools: ["read"] }));
});
afterEach(() => {
	if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
	fs.rmSync(root, { recursive: true, force: true });
});

async function fixture(conflict?: string) {
	const calls: Array<{ profile: { name: string }; task: string; cwd: string }> = [];
	let originalCalls = 0;
	const manager = { invokeProfile: async (input: typeof calls[number]) => {
		calls.push(input);
		return { action: "queued", run: { runId: "run", subSessionId: "stable-session" } };
	} } as unknown as MainRunManager;
	const settingsManager = SettingsManager.inMemory();
	let api: ExtensionAPI;
	const loader = new DefaultResourceLoader({ cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR!, settingsManager,
		noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true,
		extensionFactories: [(pi) => {
			api = pi;
			if (conflict) pi.registerCommand(conflict, { handler: async () => { originalCalls++; } });
			registerSubCommands(pi, manager);
		}],
	});
	await loader.reload();
	const modelRuntime = await ModelRuntime.create({ authPath: path.join(root, "agent", "auth.json"), modelsPath: null, refreshOnCreate: false });
	const { session } = await createAgentSession({ cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR!, settingsManager, modelRuntime, resourceLoader: loader, sessionManager: SessionManager.inMemory(root) });
	await session.bindExtensions({ onError: (error) => { throw new Error(error.error); } });
	return { session, calls, api: api!, originalCalls: () => originalCalls };
}

test("only /sub:review is registered and native completion matches /review without a model turn", async () => {
	const f = await fixture();
	try {
		const names = f.api.getCommands().map((command) => command.name);
		assert.equal(names.includes("review"), false);
		assert.equal(names.includes("sub"), false);
		assert.ok(names.includes("sub:review"));
		assert.ok(names.includes("sub:model"));
		assert.equal(names.includes("model"), false, "Do not shadow Pi's built-in command");
		const provider = new CombinedAutocompleteProvider(f.api.getCommands(), root);
		const matches = await provider.getSuggestions(["/review"], 0, 7, { signal: new AbortController().signal });
		const match = matches?.items.find((item) => item.value === "sub:review");
		assert.ok(match);
		const completed = provider.applyCompletion(["/review"], 0, 7, match, matches!.prefix).lines[0]!;
		assert.equal(completed, "/sub:review ");
		await f.session.prompt(completed + "Review MR 42");
		await f.session.prompt("/sub:review Review MR 43");
		await f.session.prompt("/sub:review Review MR 44\nFocus on changes");
		await f.session.prompt("/sub:review");
		assert.deepEqual(f.calls.slice(0, 3).map((call) => [call.profile.name, call.task]), [
			["review", "Review MR 42"], ["review", "Review MR 43"], ["review", "Review MR 44\nFocus on changes"],
		]);
		assert.match(f.calls[3]!.task, /Perform the task described by your profile/);
		assert.equal(f.session.sessionManager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "user").length, 0, "Commands must not inject a user task into Main's LLM conversation");
		await f.session.reload();
		await f.session.prompt("/sub:review After reload");
		assert.equal(f.calls.at(-1)!.task, "After reload");
	} finally { f.session.dispose(); }
});

test("an existing namespaced command is not overwritten", async () => {
	const f = await fixture("sub:review");
	try {
		await f.session.prompt("/sub:review");
		assert.equal(f.originalCalls(), 1);
		assert.equal(f.calls.length, 0);
	} finally { f.session.dispose(); }
});

test("an existing /review command is kept and /sub:review remains available", async () => {
	const f = await fixture("review");
	try {
		await f.session.prompt("/review");
		assert.equal(f.originalCalls(), 1);
		assert.equal(f.calls.length, 0);
		await f.session.prompt("/sub:review Explicit review");
		assert.equal(f.calls.length, 1);
	} finally { f.session.dispose(); }
});
