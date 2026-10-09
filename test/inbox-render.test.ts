import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import { test } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type MessageRenderer } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import subagent from "../src/index.js";
import { createChannel, MESSAGE_TYPE, readManifest, talkToMain, talkToSub } from "../src/channel.js";
import { deliverTalk } from "../src/talk-delivery.js";
import { PARENT_WAKE_TEXT } from "../src/parent-wake.js";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Parameters<MessageRenderer>[2];

for (const direction of ["to-main", "to-sub"] as const) {
	test(`${direction}: real delivery selects the inbox renderer for live and restored messages`, () => {
		const root = fs.mkdtempSync(`${os.tmpdir()}/subagent-inbox-render-`);
		const env = ["XDG_RUNTIME_DIR", "PI_SUBAGENT_ROLE", "PI_SUBAGENT_CHANNEL", "PI_SUBAGENT_TOKEN"];
		const previous = Object.fromEntries(env.map((key) => [key, process.env[key]]));
		process.env.XDG_RUNTIME_DIR = root;
		try {
			const channel = createChannel({ runId: "private-run-id", mainSessionId: "main", title: "代码复核", task: "Review", cwd: root,
				profile: { version: 1, name: "reviewer", tools: ["read"], source: "global", sourcePath: "/tmp/profile.json", resolvedSkills: [], resolvedExtensions: [] },
			});
			const manifest = readManifest(channel.channelDir);
			if (direction === "to-sub") {
				process.env.PI_SUBAGENT_ROLE = "sub";
				process.env.PI_SUBAGENT_CHANNEL = channel.channelDir;
				process.env.PI_SUBAGENT_TOKEN = channel.token;
			} else delete process.env.PI_SUBAGENT_ROLE;
			const renderers = new Map<string, MessageRenderer>();
			const submitted: Parameters<ExtensionAPI["sendMessage"]>[0][] = [];
			const wakes: string[] = [];
			const pi = {
				on: () => () => {}, registerTool: () => {}, registerCommand: () => {}, registerFlag: () => {},
				registerMessageRenderer: (name: string, renderer: MessageRenderer) => renderers.set(name, renderer),
				sendUserMessage: (text: string) => { wakes.push(text); },
				sendMessage: (message: Parameters<ExtensionAPI["sendMessage"]>[0], options: unknown) => {
					assert.deepEqual(options, { triggerTurn: false });
					submitted.push(message);
				},
			} as unknown as ExtensionAPI;
			subagent(pi);
			const session = SessionManager.inMemory(root);
			const ctx = { model: {}, sessionManager: session, isIdle: () => true } as unknown as ExtensionContext;
			const body = "第一行\nsecond line\nthird line\nfourth line\nfifth line";
			const incoming = (direction === "to-main" ? talkToMain : talkToSub)(channel.channelDir, manifest, body);
			const protocol = `[Pi Subagent internal envelope]\n${body}\nUse talk with private-run-id`;
			assert.equal(deliverTalk(pi, ctx, channel.channelDir, manifest, direction, incoming, protocol), "sent");
			assert.equal(submitted.length, 1);
			assert.deepEqual(wakes, [PARENT_WAKE_TEXT]);
			assert.ok(!wakes[0]!.includes(body), "Wake must not duplicate peer content");
			const delivered = submitted[0]!;
			assert.equal(delivered.customType, MESSAGE_TYPE);
			assert.equal(delivered.display, true);
			assert.equal(delivered.content, protocol, "The model still receives routing instructions");
			assert.deepEqual(delivered.details, { title: manifest.title, message: body, direction, runId: manifest.runId, messageId: incoming.id });
			const renderer = renderers.get(delivered.customType);
			assert.ok(renderer, "Delivery must reach a registered renderer, not only a formatting helper");
			session.appendCustomMessageEntry(delivered.customType, delivered.content, delivered.display, delivered.details);
			const restored = SessionManager.inMemory(root, undefined, session.getEntries());
			const saved = restored.getEntries().find((entry) => entry.type === "custom_message");
			assert.ok(saved?.type === "custom_message");
			for (const message of [delivered, saved]) {
				for (const width of [32, 120]) {
					for (const expanded of [false, true]) {
						const component = renderer({ ...message, role: "custom", timestamp: Date.now() }, { expanded, outputPad: 1 }, theme);
						assert.ok(component);
						const lines = component.render(width);
						const text = lines.join("\n");
						assert.match(text, /message inbox/);
						assert.match(text, /代码复核/);
						assert.match(text, /第一行/);
						assert.match(text, /third line/);
						if (expanded) {
							assert.match(text, /fifth line/);
							assert.doesNotMatch(text, /more lines/);
						} else {
							assert.doesNotMatch(text, /fourth line|fifth line/);
							assert.match(text, /2 more lines/);
						}
						assert.doesNotMatch(text, /private-run-id|Use talk|internal envelope|delivery v1|messageId/);
						assert.ok(!text.includes(incoming.id));
						assert.ok(lines.every((line) => visibleWidth(line) <= width));
					}
				}
			}
		} finally {
			for (const key of env) {
				if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
			}
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
}
