import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadProfiles, resolveProfile } from "../profiles/loader.js";
import { resolveToolExtensions } from "../profiles/tool-sources.js";
import type { MainRunManager } from "../run-manager.js";

const DEFAULT_TASK = "The user invoked this profile for the current workspace. Perform the task described by your profile; ask Main for any required details.";

export function registerSubCommands(pi: ExtensionAPI, manager: MainRunManager): void {
	const owned = new Set<string>();
	const invoke = async (name: string, task: string, ctx: ExtensionCommandContext) => {
		try {
			const profile = resolveToolExtensions(resolveProfile(name, ctx.cwd, ctx.isProjectTrusted()), pi.getAllTools());
			const result = await manager.invokeProfile({ profile, task: task.trim() || DEFAULT_TASK, cwd: ctx.cwd });
			ctx.ui.notify(`${result.action}: ${name} · ${result.run.runId.slice(0, 8)}${result.run.subSessionId ? ` · session ${result.run.subSessionId}` : ""}`, "info");
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	};

	// Trust and other extensions' startup registrations are resolved at this point.
	// Only register the namespaced command; Pi's native fuzzy completion matches
	// /review to /sub:review without an alias or a separate routing hook.
	pi.on("resources_discover", (_event, ctx) => {
		const catalog = loadProfiles(ctx.cwd, ctx.isProjectTrusted());
		const occupied = new Set(pi.getCommands().map((command) => command.name));
		for (const name of [...catalog.profiles.keys()].sort()) {
			const command = `sub:${name}`;
			if (occupied.has(command) && !owned.has(command)) {
				ctx.ui.notify(`Cannot register /${command}: another command already uses that name.`, "warning");
				continue;
			}
			pi.registerCommand(command, {
				description: `Manually invoke profile ${name}; reuse its Sub in this Main session`,
				handler: (task, commandCtx) => invoke(name, task, commandCtx),
			});
			owned.add(command);
		}
	});
}
