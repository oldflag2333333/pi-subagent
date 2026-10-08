import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	listTalkToSub,
	MESSAGE_TYPE,
	clearActiveTurn,
	clearInterrupt,
	readActiveTurn,
	readInterrupt,
	readClose,
	readManifest,
	talkToMain,
	writeSubClosed,
	writeSubSessionInfo,
	writeActiveTurn,
} from "../channel.js";
import { applySubPromptSections, bindPromptSections } from "../profiles/system-prompt.js";
import { SUB_CONTROL_TOOLS } from "../profiles/launch-args.js";
import { applyProfileTools } from "../profiles/tool-selection.js";
import { MANUAL_SUB_GUIDANCE, subSessionName } from "../manual-context.js";
import { talkView } from "../talk-render.js";
import { ChannelMonitor } from "../channel-monitor.js";
import { bindInboxEvents } from "../inbox-state.js";
import { deliverTalk, ProtocolErrors } from "../talk-delivery.js";
import type { ActiveTurn, DelegateManifest } from "../types.js";

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => part && typeof part === "object" && "text" in part ? String(part.text) : "")
		.filter(Boolean)
		.join("\n");
}

function loadManifest(): { channelDir: string; manifest: DelegateManifest } {
	const channelDir = process.env.PI_FACETS_CHANNEL;
	const envToken = process.env.PI_FACETS_TOKEN;
	if (!channelDir) throw new Error("PI_FACETS_CHANNEL is missing in Sub Pi.");
	const manifest = readManifest(channelDir);
	if (!envToken || envToken !== manifest.token) throw new Error("Sub channel capability token does not match.");
	return { channelDir, manifest };
}

export function registerSub(pi: ExtensionAPI): void {
	const loaded = loadManifest();
	const selectedTools = [...new Set([...loaded.manifest.profile.tools, ...SUB_CONTROL_TOOLS])];
	const protocolErrors = new ProtocolErrors();
	let closing = false;
	let activeTurn: ActiveTurn | undefined;
	let inputSeen = false;
	let activeContext: ExtensionContext | undefined;
	let ready = false;
	const monitor = new ChannelMonitor(
		() => scan(),
		(_id, error) => {
			if (activeContext) protocolErrors.report(activeContext, `watch:${loaded.manifest.runId}`, new Error(`File watching unavailable; the 5-second scan remains active. ${error instanceof Error ? error.message : String(error)}`));
		},
		() => protocolErrors.clear(`watch:${loaded.manifest.runId}`),
	);
	bindInboxEvents(pi, () => activeContext, () => monitor.wakeAll());

	// Pi emits resource discovery after all session_start handlers, including
	// extensions that register the profile's tools dynamically during startup.
	pi.on("resources_discover", (_event, ctx) => {
		try {
			applyProfileTools(pi, loaded.manifest.profile.name, selectedTools);
			ready = true;
			monitor.wakeAll();
		} catch (error) {
			const reason = `Unable to initialize Sub profile: ${error instanceof Error ? error.message : String(error)}`;
			talkToMain(loaded.channelDir, loaded.manifest, reason);
			ctx.shutdown();
		}
	});

	pi.on("session_start", (_event, ctx) => {
		activeContext = ctx;
		pi.setSessionName(subSessionName(loaded.manifest.title, loaded.manifest.origin));
		ctx.ui.setTitle(`[sub] ${loaded.manifest.title}`);
		ctx.ui.setStatus("facets", `sub · ${loaded.manifest.profile.name}`);
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (loaded.manifest.profile.sessionPersistence === "persistent" && sessionFile) {
			writeSubSessionInfo(loaded.channelDir, loaded.manifest, {
				sessionId: ctx.sessionManager.getSessionId(),
				sessionFile,
			});
		}
		const previousTurn = readActiveTurn(loaded.channelDir, loaded.manifest);
		if (ctx.isIdle() && previousTurn) clearActiveTurn(loaded.channelDir, previousTurn);
		activeTurn = ctx.isIdle() ? undefined : previousTurn;
		monitor.add(loaded.manifest.runId, loaded.channelDir, "to-sub");
		monitor.start();
		scan();
	});

	function scan(): void {
		const ctx = activeContext;
		if (!ctx || closing) return;
		try {
			if (readClose(loaded.channelDir, loaded.manifest)) {
				closing = true;
				monitor.stop();
				ctx.abort();
				ctx.shutdown();
				return;
			}
			const interrupt = readInterrupt(loaded.channelDir, loaded.manifest);
			if (interrupt) {
				clearInterrupt(loaded.channelDir);
				if (!ctx.isIdle() && interrupt.turnId === activeTurn?.turnId) ctx.abort();
			}
			if (!ready) return;
			for (const message of listTalkToSub(loaded.channelDir, loaded.manifest)) {
				deliverTalk(pi, ctx, loaded.channelDir, loaded.manifest, "to-sub", message,
					`[Facets Main message]\nMain says:\n${message.message}`);
			}
			protocolErrors.clear(loaded.manifest.runId);
		} catch (error) {
			protocolErrors.report(ctx, loaded.manifest.runId, error);
		}
	}

	pi.on("agent_start", () => {
		if (closing) return;
		inputSeen = false;
		activeTurn = writeActiveTurn(loaded.channelDir, loaded.manifest);
	});

	pi.on("message_start", (event) => {
		const message = event.message;
		const mainInput = message.role === "custom" && message.customType === MESSAGE_TYPE
			&& (message.details as { direction?: string } | undefined)?.direction === "to-sub";
		// Native follow-ups can start new work inside one agent run. A late
		// interrupt for the previous input must not abort that subsequent work.
		if (!closing && (message.role === "user" || mainInput)) {
			if (inputSeen) activeTurn = writeActiveTurn(loaded.channelDir, loaded.manifest);
			inputSeen = true;
		}
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.isIdle() && activeTurn) {
			clearActiveTurn(loaded.channelDir, activeTurn);
			activeTurn = undefined;
		}
	});

	bindPromptSections(pi, ["facets_sub_protocol", "facets_profile"], () => {
		const sections: Record<string, string> = {};
		applySubPromptSections(sections, loaded.manifest.profile);
		if (loaded.manifest.origin === "manual") sections.facets_sub_protocol += `\n\n${MANUAL_SUB_GUIDANCE}`;
		return sections;
	});

	// Preserve rendering for legacy custom messages in resumed sessions.
	pi.registerMessageRenderer(MESSAGE_TYPE, (message, options, theme) => {
		const details = message.details as { title?: string; message?: string } | undefined;
		const title = details?.title ?? loaded.manifest.title;
		const mainMessage = details?.message ?? "";
		const view = talkView(mainMessage, options.expanded);
		let text = `${theme.fg("accent", "›")} ${theme.fg("toolTitle", theme.bold("message inbox"))} ${theme.fg("muted", `· ${title}`)}`;
		if (mainMessage) text += `\n\n${view.lines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (view.remaining > 0) {
			text += theme.fg("muted", `\n... (${view.remaining} more lines, ${view.totalLines} total, ctrl+o to expand)`);
		}
		const box = new Box(1, 1, (line) => theme.bg("toolSuccessBg", line));
		box.addChild(new Text(text, 0, 0));
		return box;
	});

	pi.registerTool({
		name: "talk",
		label: "talk",
		exposure: "model-only",
		description: "Send one message to the Main Pi and end the current turn. Use it to ask for information or deliver work. Format non-trivial messages as readable Markdown with paragraph breaks and lists.",
		promptSnippet: "Send a message to the Main Pi",
		promptGuidelines: ["Use talk whenever the Sub needs to communicate with the Main; the Main decides when to close the Sub session."],
		executionMode: "sequential",
		parameters: Type.Object({
			message: Type.String({ description: "Message to the other Agent. For non-trivial content, use readable Markdown with paragraph breaks and lists." }),
		}),
		renderCall(args, theme, context) {
			const message = typeof args.message === "string" ? args.message : "";
			const view = talkView(message, context.expanded);
			let text = `${theme.fg("accent", "›")} ${theme.fg("toolTitle", theme.bold("message send"))} ${theme.fg("muted", `· ${loaded.manifest.title}`)}`;
			if (message) text += `\n\n${view.lines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
			if (view.remaining > 0) {
				text += theme.fg("muted", `\n... (${view.remaining} more lines, ${view.totalLines} total, ctrl+o to expand)`);
			}
			return new Text(text, 0, 0);
		},
		async execute(_id, params) {
			const message = talkToMain(loaded.channelDir, loaded.manifest, params.message);
			return {
				content: [{ type: "text", text: "Message queued for the Main Pi." }],
				details: { messageId: message.id },
				terminate: true,
			};
		},
		renderResult(result, _options, theme, context) {
			if (context.isError) return new Text(`\n${theme.fg("error", contentText(result.content) || "talk failed")}`, 0, 0);
			return new Container();
		},
	});

	pi.on("session_shutdown", (event) => {
		monitor.stop();
		activeContext = undefined;
		if (event.reason === "quit" && !closing && !readClose(loaded.channelDir, loaded.manifest)) {
			writeSubClosed(loaded.channelDir, loaded.manifest, "The Sub session was closed manually.");
		}
	});
}
