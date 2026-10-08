import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createChannel, readActiveTurn, readInterrupt, readManifest, writeInterrupt } from "../src/channel.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("Sub aborts only the targeted turn and stays open", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-facets-interrupt-"));
	const previous = { channel: process.env.PI_FACETS_CHANNEL, token: process.env.PI_FACETS_TOKEN, runtime: process.env.XDG_RUNTIME_DIR };
	process.env.XDG_RUNTIME_DIR = root;
	const channel = createChannel({
		runId: "run-1", mainSessionId: "main-1", title: "Review", task: "Review it", cwd: root,
		profile: { version: 1, name: "reviewer", tools: ["read"], source: "global", sourcePath: "/tmp/reviewer.json", resolvedSkills: [], resolvedExtensions: [] },
	});
	process.env.PI_FACETS_CHANNEL = channel.channelDir;
	process.env.PI_FACETS_TOKEN = channel.token;
	const handlers = new Map<string, Array<(...args: any[]) => void>>();
	const pi = {
		on: (event: string, handler: (...args: any[]) => void) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		setSessionName: () => {},
		registerMessageRenderer: () => {},
		registerTool: () => {},
		getAllTools: () => [{ name: "read" }, { name: "talk" }],
		setActiveTools: () => {},
		getActiveTools: () => ["read", "talk"],
	} as unknown as ExtensionAPI;
	let idle = true;
	let aborts = 0;
	let shutdowns = 0;
	let stopProtocol: (() => void) | undefined;
	const ctx = {
		isIdle: () => idle,
		abort: () => { aborts++; idle = true; },
		shutdown: () => { shutdowns++; },
		ui: { setTitle: () => {}, setStatus: () => {} },
		sessionManager: { getSessionFile: () => undefined },
	} as unknown as ExtensionContext;
	try {
		// Register against the Sub\'s configured channel environment.
		const { registerSub } = await import("../src/tools/sub.js");
		registerSub(pi);
		const fire = (event: string, ...args: unknown[]) => handlers.get(event)?.forEach((handler) => handler(...args));
		stopProtocol = () => fire("session_shutdown", { reason: "reload" }, ctx);
		fire("session_start", {}, ctx);
		fire("resources_discover", { reason: "startup" }, ctx);
		idle = false;
		fire("agent_start", {}, ctx);
		const manifest = readManifest(channel.channelDir);
		const first = readActiveTurn(channel.channelDir, manifest)!;
		writeInterrupt(channel.channelDir, manifest, first);
		await delay(550);
		assert.equal(aborts, 1);
		assert.equal(shutdowns, 0);
		assert.equal(readInterrupt(channel.channelDir, manifest), undefined);
		fire("agent_settled", {}, ctx);
		assert.equal(readActiveTurn(channel.channelDir, manifest), undefined);

		// A late request for the previous turn must not abort a subsequent turn.
		writeInterrupt(channel.channelDir, manifest, first);
		idle = false;
		fire("agent_start", {}, ctx);
		assert.notEqual(readActiveTurn(channel.channelDir, manifest)?.turnId, first.turnId);
		await delay(450);
		assert.equal(aborts, 1);
		assert.equal(readInterrupt(channel.channelDir, manifest), undefined);

		// A native follow-up may begin new work without another agent_start.
		const initialInputTurn = readActiveTurn(channel.channelDir, manifest)!;
		fire("message_start", { message: { role: "user", content: "Initial task" } }, ctx);
		assert.equal(readActiveTurn(channel.channelDir, manifest)?.turnId, initialInputTurn.turnId);
		const second = readActiveTurn(channel.channelDir, manifest)!;
		writeInterrupt(channel.channelDir, manifest, second);
		fire("message_start", { message: { role: "user", content: "Follow-up from Main" } }, ctx);
		const nextInput = readActiveTurn(channel.channelDir, manifest)!;
		assert.notEqual(nextInput.turnId, second.turnId);
		await delay(150);
		assert.equal(aborts, 1);
		writeInterrupt(channel.channelDir, manifest, nextInput);
		await delay(150);
		assert.equal(aborts, 2);
		assert.equal(shutdowns, 0);
	} finally {
		stopProtocol?.();
		for (const [key, value] of Object.entries(previous)) {
			const env = key === "channel" ? "PI_FACETS_CHANNEL" : key === "token" ? "PI_FACETS_TOKEN" : "XDG_RUNTIME_DIR";
			if (value === undefined) delete process.env[env]; else process.env[env] = value;
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
});
