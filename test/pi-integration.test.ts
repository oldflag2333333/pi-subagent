import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createCodemodeExtension,
	createMcpExtension,
	type McpExtensionOptions,
	createToolSearchExtension,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createChannel, listTalkToMain, readManifest } from "../src/channel.js";
import { registerMainTools } from "../src/tools/main.js";
import { StartupProfileRuntime } from "../src/profiles/runtime.js";
import { subCapabilityArgs } from "../src/profiles/launch-args.js";
import { resolveToolExtensions } from "../src/profiles/tool-sources.js";
import type { ResolvedProfile } from "../src/profiles/types.js";

const builtinFactories = [
	{ name: "codemode", builtin: true, factory: createCodemodeExtension({ models: false }) },
	{ name: "tool-search", builtin: true, factory: createToolSearchExtension() },
];

function profile(tools: string[]): ResolvedProfile {
	return { version: 1, name: "reviewer", source: "global", sourcePath: "/tmp/reviewer.json", tools, resolvedSkills: [], resolvedExtensions: [] };
}

async function openSession(root: string, explicitBuiltins: string[], factory?: (pi: ExtensionAPI) => void, flag?: string, tools?: string[], mcpOptions: McpExtensionOptions = { loadConfig: () => ({ servers: [], errors: [] }) }) {
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd: root, agentDir, settingsManager,
		noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
		additionalExtensionPaths: explicitBuiltins,
		extensionFactories: [...builtinFactories, { name: "mcp", builtin: true, factory: createMcpExtension(mcpOptions) }, ...(factory ? [{ name: "fixture", factory }] : [])],
	});
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	if (flag) resourceLoader.getExtensions().runtime.flagValues.set("profile", flag);
	const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	const { session } = await createAgentSession({
		cwd: root, agentDir, settingsManager, modelRuntime, resourceLoader, sessionManager: SessionManager.inMemory(root), tools,
	});
	await session.bindExtensions({});
	return session;
}

function issueCall(session: Awaited<ReturnType<typeof openSession>>, name: string, args: Record<string, string>) {
	const id = `fixture-${session.sessionManager.getEntries().length}`;
	const assistant: AssistantMessage = {
		role: "assistant", api: "openai-responses", provider: "fixture", model: "fixture",
		content: [{ type: "toolCall", id, name, arguments: args }], stopReason: "toolUse", timestamp: Date.now(),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
	// SessionManager is the canonical context; no model request or credential is needed.
	session.sessionManager.appendMessage(assistant);
	session.refreshContext();
	const tool = session.agent.state.tools.find((candidate) => candidate.name === name);
	assert.ok(tool, `Expected active tool ${name}`);
	return tool.execute(id, args, new AbortController().signal);
}

function fixtureTools(pi: ExtensionAPI, executed: string[]) {
	for (const [name, exposure] of [["allowed", "direct"], ["excluded", "deferred"], ["unselected_codemode", "codemode"]] as const) {
		pi.registerTool({ name, label: name, description: name, exposure, parameters: Type.Object({}),
			execute: async () => {
				executed.push(name);
				return { content: [{ type: "text", text: name }], details: undefined };
			},
		});
	}
	pi.registerTool({ name: "nested_probe", label: "nested probe", description: "Exercise Pi's nested tool pipeline",
		parameters: Type.Object({ target: Type.String() }),
		execute: async (_id, args, signal, _update, ctx) => {
			const outcome = await ctx.executeTool(args.target, {}, { signal });
			return { content: outcome.result.content, details: { isError: outcome.isError } };
		},
	});
}

test("Sub launch loads its selected extensions plus native MCP support", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "facets-pi-builtins-"));
	let main: Awaited<ReturnType<typeof openSession>> | undefined;
	let sub: typeof main;
	try {
		main = await openSession(root, ["builtin:codemode", "builtin:tool-search"]);
		for (const tools of [["read"], ["read", "codemode"], ["read", "codemode", "tool_search"]]) {
			const resolved = resolveToolExtensions(profile(tools), main.getAllTools());
			const args = subCapabilityArgs(resolved, "/tmp/facets.ts");
			const explicit = args.flatMap((arg, i) => arg === "-e" ? [args[i + 1]!] : []);
			sub = await openSession(root, explicit);
			const available = new Set(sub.getAllTools().map((tool) => tool.name));
			for (const name of tools) assert.ok(available.has(name));
			assert.equal(available.has("codemode"), true);
			assert.equal(available.has("tool_search"), true);
			await sub.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
			sub.dispose();
			sub = undefined;
		}
	} finally {
		sub?.dispose();
		main?.dispose();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("startup profiles select active tools without adding a nested execution policy", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "facets-pi-selection-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
	const profileDir = path.join(root, "agent", "facets", "profiles");
	fs.mkdirSync(profileDir, { recursive: true });
	fs.writeFileSync(path.join(profileDir, "reviewer.json"), JSON.stringify({ version: 1, name: "reviewer", tools: ["codemode", "nested_probe", "allowed"] }));
	const executed: string[] = [];
	let session: Awaited<ReturnType<typeof openSession>> | undefined;
	try {
		session = await openSession(root, ["builtin:codemode"], (pi) => {
			fixtureTools(pi, executed);
			new StartupProfileRuntime(pi).register();
			pi.registerCommand("add_fixture", { description: "Register after startup", handler: async () => {
				pi.registerTool({ name: "late_excluded", label: "late", description: "late", exposure: "deferred", parameters: Type.Object({}),
					execute: async () => { executed.push("late_excluded"); return { content: [{ type: "text", text: "late" }], details: undefined }; },
				});
			} });
		}, "reviewer");
		assert.deepEqual(new Set(session.getActiveToolNames()), new Set(["codemode", "nested_probe", "allowed"]));
		assert.ok(session.getCallableToolNames().includes("excluded"), "Startup selection is not an execution boundary");
		const allowed = await issueCall(session, "nested_probe", { target: "allowed" });
		assert.deepEqual(allowed.details, { isError: false });
		const extra = await issueCall(session, "nested_probe", { target: "excluded" });
		assert.deepEqual(extra.details, { isError: false });
		const script = await issueCall(session, "codemode", { code: "return await tools.excluded({});" });
		assert.match(JSON.stringify(script.content), /excluded/);
		await session.prompt("/add_fixture");
		const late = await issueCall(session, "nested_probe", { target: "late_excluded" });
		assert.deepEqual(late.details, { isError: false });
		assert.deepEqual(executed, ["allowed", "excluded", "excluded", "late_excluded"]);
	} finally {
		session?.dispose();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("starting without a profile does not restrict Pi's deferred tools", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "facets-pi-no-profile-"));
	const executed: string[] = [];
	let session: Awaited<ReturnType<typeof openSession>> | undefined;
	try {
		session = await openSession(root, [], (pi) => {
			fixtureTools(pi, executed);
			new StartupProfileRuntime(pi).register();
		});
		const result = await issueCall(session, "nested_probe", { target: "excluded" });
		assert.deepEqual(result.details, { isError: false });
		assert.deepEqual(executed, ["excluded"]);
	} finally {
		session?.dispose();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("Main delegate stays directly active but is not callable from nested tools", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "facets-pi-main-control-"));
	let session: Awaited<ReturnType<typeof openSession>> | undefined;
	try {
		session = await openSession(root, [], (pi) => {
			fixtureTools(pi, []);
			registerMainTools(pi, { runs: new Map() } as never);
		});
		assert.equal(session.getToolDefinition("delegate")?.exposure, "model-only");
		assert.ok(session.getActiveToolNames().includes("delegate"));
		assert.equal(session.getCallableToolNames().includes("delegate"), false);
		assert.ok(session.getCallableToolNames().includes("talk"));
		assert.ok(session.getCallableToolNames().includes("list_sub"));
		const nested = await issueCall(session, "nested_probe", { target: "delegate" });
		assert.deepEqual(nested.details, { isError: true });
	} finally {
		session?.dispose();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("Sub keeps native MCP servers, exposure, and resources without profile filtering", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "facets-pi-sub-mcp-"));
	const previous = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_FACETS_CHANNEL", "PI_FACETS_TOKEN", "XDG_RUNTIME_DIR"].map((key) => [key, process.env[key]]));
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
	process.env.XDG_RUNTIME_DIR = root;
	const command = process.execPath;
	const args = [fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url))];
	fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "mcp.json"), JSON.stringify({
		mcpServers: {
			fixture: { command, args, exposure: "codemode", toolExposure: { direct: "direct", hidden: "hidden" } },
			extra: { command, args, exposure: "codemode" },
			disabled: { command, args, enabled: false },
		},
	}));
	const selectedProfile = resolveToolExtensions(profile(["read", "mcp__fixture__echo"]), [
		{ name: "read", sourceInfo: { source: "builtin", path: "builtin:read" } },
	]);
	const channel = createChannel({ runId: "mcp-sub", mainSessionId: "main", title: "MCP", task: "Review", cwd: root, profile: selectedProfile });
	process.env.PI_FACETS_CHANNEL = channel.channelDir;
	process.env.PI_FACETS_TOKEN = channel.token;
	const launch = subCapabilityArgs(selectedProfile, "/tmp/facets.ts");
	const extensions = launch.flatMap((arg, index) => arg === "-e" ? [launch[index + 1]!] : []);
	const tools = launch[launch.indexOf("--tools") + 1]!.split(",");
	let session: Awaited<ReturnType<typeof openSession>> | undefined;
	try {
		const { registerSub } = await import("../src/tools/sub.js");
		// Empty options select Pi's real mcp.json loader, not a Facets server snapshot.
		session = await openSession(root, extensions, registerSub, undefined, tools, {});
		assert.deepEqual(listTalkToMain(channel.channelDir, readManifest(channel.channelDir)), [], "Pending MCP discovery must not fail Sub initialization");
		assert.ok(session.getActiveToolNames().includes("talk"));
		assert.equal(session.getAllTools().some((tool) => tool.name === "mcp__fixture__echo"), false);
		const deadline = Date.now() + 5000;
		const connected = () => ["mcp__fixture__echo", "mcp__extra__echo", "list_mcp_resources"].every((name) => session!.getAllTools().some((tool) => tool.name === name));
		while (!connected() && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const names = session.getAllTools().map((tool) => tool.name);
		assert.ok(names.includes("mcp__fixture__echo"));
		assert.ok(names.includes("mcp__extra__echo"), "A profile MCP reference must not limit other configured servers");
		assert.equal(names.some((name) => name.startsWith("mcp__disabled__")), false);
		assert.ok(session.getActiveToolNames().includes("mcp__fixture__direct"));
		assert.equal(session.getActiveToolNames().includes("mcp__fixture__echo"), false, "Keep native indirect exposure");
		assert.equal(session.getCallableToolNames().includes("mcp__fixture__hidden"), false);
		assert.ok(session.getCallableToolNames().includes("list_mcp_resources"));
		const reply = await issueCall(session, "codemode", { code: "return await tools.mcp__extra__echo({});" });
		assert.match(JSON.stringify(reply.content), /MCP fixture: echo/);
		const direct = await issueCall(session, "mcp__fixture__direct", {});
		assert.match(JSON.stringify(direct.content), /MCP fixture: direct/);
		assert.deepEqual(listTalkToMain(channel.channelDir, readManifest(channel.channelDir)), []);
	} finally {
		await session?.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
		session?.dispose();
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("Sub startup uses Pi tool selection to keep the registry and Codemode context clean", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "facets-pi-sub-selection-"));
	const previous = { channel: process.env.PI_FACETS_CHANNEL, token: process.env.PI_FACETS_TOKEN, runtime: process.env.XDG_RUNTIME_DIR };
	process.env.XDG_RUNTIME_DIR = root;
	const channel = createChannel({ runId: "sub-selection", mainSessionId: "main", title: "Review", task: "Review", cwd: root, profile: profile(["codemode", "nested_probe", "allowed"]) });
	process.env.PI_FACETS_CHANNEL = channel.channelDir;
	process.env.PI_FACETS_TOKEN = channel.token;
	const executed: string[] = [];
	let session: Awaited<ReturnType<typeof openSession>> | undefined;
	try {
		const { registerSub } = await import("../src/tools/sub.js");
		// Use the same --tools selection as the real Sub launcher, not only setActiveTools.
		const args = subCapabilityArgs(channel.profile, "/tmp/facets.ts");
		const selected = args[args.indexOf("--tools") + 1]!.split(",");
		session = await openSession(root, ["builtin:codemode", "builtin:tool-search", "builtin:mcp"], (pi) => {
			registerSub(pi);
			// Registration deliberately happens after Facets\' session_start handler.
			pi.on("session_start", () => { fixtureTools(pi, executed); });
		}, undefined, selected);
		const expected = ["codemode", "tool_search", "nested_probe", "allowed", "talk"];
		assert.deepEqual(new Set(session.getActiveToolNames()), new Set(expected));
		assert.deepEqual(new Set(session.getAllTools().map((tool) => tool.name)), new Set(expected));
		assert.equal(session.getCallableToolNames().includes("excluded"), false);
		assert.equal(session.getCallableToolNames().includes("unselected_codemode"), false);
		const codemode = session.agent.state.tools.find((tool) => tool.name === "codemode")!;
		assert.doesNotMatch(codemode.description, /\b(excluded|unselected_codemode)\b/);
		assert.doesNotMatch(session.systemPrompt, /\b(excluded|unselected_codemode)\b/);
		assert.equal(session.getToolDefinition("talk")?.exposure, "model-only");
		assert.equal(session.getCallableToolNames().includes("talk"), false);
		const nestedTalk = await issueCall(session, "nested_probe", { target: "talk" });
		assert.deepEqual(nestedTalk.details, { isError: true });
		assert.deepEqual(listTalkToMain(channel.channelDir, readManifest(channel.channelDir)), []);
		const directTalk = await issueCall(session, "talk", { message: "Delivery" });
		assert.equal(directTalk.terminate, true);
		assert.equal(listTalkToMain(channel.channelDir, readManifest(channel.channelDir)).length, 1);
		const allowed = await issueCall(session, "nested_probe", { target: "allowed" });
		assert.deepEqual(allowed.details, { isError: false });
		assert.deepEqual(executed, ["allowed"]);
	} finally {
		await session?.extensionRunner?.emit({ type: "session_shutdown", reason: "reload" });
		session?.dispose();
		for (const [key, value] of Object.entries(previous)) {
			const env = key === "channel" ? "PI_FACETS_CHANNEL" : key === "token" ? "PI_FACETS_TOKEN" : "XDG_RUNTIME_DIR";
			if (value === undefined) delete process.env[env]; else process.env[env] = value;
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
});
