import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createChannel, listTalkToSub, readManifest, talkToSub, writeClose } from "../src/channel.js";

// Fake timers exercise the actual Sub poller without wall-clock sleeps.
test("Sub retains failed messages, isolates protocol errors, and shuts down only once", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "facets-sub-delivery-"));
	const previous = { PI_FACETS_CHANNEL: process.env.PI_FACETS_CHANNEL, PI_FACETS_TOKEN: process.env.PI_FACETS_TOKEN, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR };
	process.env.XDG_RUNTIME_DIR = root;
	const channel = createChannel({ runId: "sub", mainSessionId: "main", title: "Sub", task: "Review", cwd: root,
		profile: { version: 1, name: "reviewer", tools: ["read"], source: "global", sourcePath: "/tmp/profile.json", resolvedSkills: [], resolvedExtensions: [] },
	});
	process.env.PI_FACETS_CHANNEL = channel.channelDir;
	process.env.PI_FACETS_TOKEN = channel.token;
	const manifest = readManifest(channel.channelDir);
	const session = SessionManager.inMemory(root);
	const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
	const received: any[] = [];
	const warnings: string[] = [];
	let failing = false;
	let aborts = 0;
	let shutdowns = 0;
	const pi = {
		on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerTool: () => {}, registerMessageRenderer: () => {}, setSessionName: () => {},
		getAllTools: () => [{ name: "read" }, { name: "talk" }], setActiveTools: () => {}, getActiveTools: () => ["read", "talk"],
		sendUserMessage: (message: any) => {
			if (failing) throw new Error("Submission failed");
			received.push(message);
			session.appendMessage({ role: "user", content: message, timestamp: Date.now() });
		},
	} as unknown as ExtensionAPI;
	const ctx = { model: {}, sessionManager: session, isIdle: () => true, hasPendingMessages: () => false, hasUI: true,
		abort: () => { aborts++; }, shutdown: () => { shutdowns++; },
		ui: { setTitle: () => {}, setStatus: () => {}, notify: (message: string) => warnings.push(message) },
	} as unknown as ExtensionContext;
	const fire = (event: string, data: unknown) => handlers.get(event)?.forEach((handler) => handler(data, ctx));
	const rescan = () => { t.mock.timers.tick(5000); t.mock.timers.tick(20); };
	try {
		const { registerSub } = await import("../src/tools/sub.js");
		registerSub(pi);
		fire("session_start", {});
		fire("resources_discover", { reason: "startup" });
		talkToSub(channel.channelDir, manifest, "Initial message");
		t.mock.timers.tick(20);
		assert.deepEqual(listTalkToSub(channel.channelDir, manifest), []);
		assert.equal(received.length, 1);
		failing = true;
		talkToSub(channel.channelDir, manifest, "Retry message");
		rescan(); rescan();
		assert.equal(listTalkToSub(channel.channelDir, manifest).length, 1);
		assert.equal(warnings.length, 1);
		failing = false;
		rescan();
		assert.deepEqual(listTalkToSub(channel.channelDir, manifest), []);
		assert.equal(received.length, 2);
		const bad = path.join(channel.channelDir, "to-sub", "bad.json");
		fs.writeFileSync(bad, "{broken");
		rescan(); rescan();
		assert.equal(warnings.length, 2);
		assert.equal(shutdowns, 0);
		fs.rmSync(bad);
		talkToSub(channel.channelDir, manifest, "Recovered message");
		rescan();
		assert.equal(received.length, 3);
		assert.ok(received[2].includes("Recovered message"));
		writeClose(channel.channelDir, manifest, "Done");
		rescan(); rescan(); rescan();
		assert.equal(aborts, 1);
		assert.equal(shutdowns, 1);
	} finally {
		fire("session_shutdown", { reason: "reload" });
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
});
