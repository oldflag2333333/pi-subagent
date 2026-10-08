import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { MESSAGE_TYPE } from "./channel.js";
import { MainContextRuntime } from "./main-context.js";
import { StartupProfileRuntime } from "./profiles/runtime.js";
import { MainRunManager } from "./run-manager.js";
import { registerSub } from "./tools/sub.js";
import { talkView } from "./talk-render.js";
import { registerSubCommands } from "./commands/sub.js";
import { registerMainTools } from "./tools/main.js";

export default function piDelegate(pi: ExtensionAPI): void {
	if (process.env.PI_FACETS_ROLE === "sub") {
		registerSub(pi);
		return;
	}

	const manager = new MainRunManager(pi);
	const startupProfile = new StartupProfileRuntime(pi);
	registerMainTools(pi, manager);
	registerSubCommands(pi, manager);
	startupProfile.register();
	new MainContextRuntime(pi).register();

	// Preserve rendering for legacy custom messages in resumed sessions.
	pi.registerMessageRenderer(MESSAGE_TYPE, (message, options, theme) => {
		const details = message.details as { title?: string; message?: string } | undefined;
		const title = details?.title ?? "Sub";
		const subMessage = details?.message ?? "";
		const view = talkView(subMessage, options.expanded);
		let text = `${theme.fg("accent", "›")} ${theme.fg("toolTitle", theme.bold("message inbox"))} ${theme.fg("muted", `· ${title}`)}`;
		if (subMessage) text += `\n\n${view.lines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (view.remaining > 0) {
			text += theme.fg("muted", `\n... (${view.remaining} more lines, ${view.totalLines} total, ctrl+o to expand)`);
		}
		const box = new Box(1, 1, (line) => theme.bg("toolSuccessBg", line));
		box.addChild(new Text(text, 0, 0));
		return box;
	});
	pi.on("session_start", (_event, ctx) => manager.start(ctx));

	pi.on("session_shutdown", () => manager.shutdown());
}
