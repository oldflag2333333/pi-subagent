import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubAgentStatus, SubLaunchSpec, SubSurfaceAdapter, SurfaceHandle } from "../types.js";
import { HerdrLaunchCleanupError, subArgs } from "./herdr.js";
import { launchScriptContent, launchScriptPath, reapAbandonedLaunchScripts } from "./launch-script.js";

function parse(text: string): any {
	return JSON.parse(text);
}
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/** Only the private launcher's path crosses the PTY, never Pi args or secrets. */
export function coreLaunchCommand(launcher: string): string {
	const command = `exec sh ${quote(launcher)}`;
	// Fail explicitly rather than silently truncate at a terminal's canonical limit.
	if (Buffer.byteLength(command, "utf8") > 900) throw new Error("Sub launcher path is too long for terminal input.");
	return command;
}

/** Native core children appear beneath Main in Desktop without creating a tab. */
export class HerdrCoreAdapter implements SubSurfaceAdapter {
	readonly id = "herdr" as const;
	constructor(private readonly pi: ExtensionAPI) {}

	private async command(binary: string, args: string[], signal?: AbortSignal, timeout = 10_000): Promise<any> {
		signal?.throwIfAborted();
		const result = await this.pi.exec(binary, args, { signal, timeout });
		signal?.throwIfAborted();
		if (result.code !== 0 || result.killed) throw new Error(result.stderr || result.stdout || `${binary} failed`);
		return parse(result.stdout);
	}

	async available(): Promise<boolean> {
		if (!process.env.HC_TERMINAL_ID) return false;
		try {
			await this.command("herdr-core", ["get", process.env.HC_TERMINAL_ID], undefined, 3000);
			return true;
		} catch { return false; }
	}

	async launch(spec: SubLaunchSpec, signal?: AbortSignal): Promise<SurfaceHandle> {
		signal?.throwIfAborted();
		const parent = process.env.HC_TERMINAL_ID;
		if (!parent) throw new Error("HC_TERMINAL_ID is unavailable; Main is not running in herdr-core.");
		reapAbandonedLaunchScripts();
		const launcher = launchScriptPath(spec.channelDir);
		const launchCommand = coreLaunchCommand(launcher);
		const env = { PI_SUBAGENT_ROLE: "sub", PI_SUBAGENT_CHANNEL: spec.channelDir, PI_SUBAGENT_TOKEN: spec.token };
		// Keep credentials and long capability paths off both the PTY and app argv.
		const script = launchScriptContent(subArgs(spec)).replace("exec pi ",
			Object.entries(env).map(([key, value]) => `export ${key}=${quote(value)}\n`).join("") + "exec pi ");
		fs.writeFileSync(launcher, script, { flag: "wx", mode: 0o600 });
		let handle: SurfaceHandle | undefined;
		try {
			// Parse creation even after cancellation so a returned handle can be rolled back.
			const result = await this.pi.exec("herdr-core", ["run", "--bg", "--json",
				"--parent", parent, "--no-notify", "--outlive-parent",
				"--cwd", spec.cwd,
				"--label", "subagent_role=sub", "--label", `subagent_main_session=${spec.mainSessionId}`,
				"--label", `subagent_run_id=${spec.runId}`, "--label", `subagent_profile=${spec.profile.name}`,
				// No argv: let core start the configured interactive shell normally.
				// Its first prompt runs all user hooks before it consumes our command.
			], { signal, timeout: 15_000 });
			const created = parse(result.stdout);
			if (typeof created.address === "string") {
				handle = { adapter: "herdr", backend: "core", terminalId: created.address };
			}
			signal?.throwIfAborted();
			if (result.code !== 0 || result.killed || !handle?.terminalId) {
				throw new Error(result.stderr || "herdr-core did not return a Sub terminal.");
			}
			// Use core's normal terminal input path, not -c/exec during shell startup.
			// A failed send is never retried: it may already have been admitted.
			await this.command("herdr-core", ["send", handle.terminalId, launchCommand], signal, 70_000);
			await this.command("herdr-core", ["wait", handle.terminalId, "--timeout", "60"], signal, 65_000);
			const ready = await this.command("herdr-core", ["get", handle.terminalId], signal);
			if (ready.address !== handle.terminalId || ready.state !== "live" || ready.status?.app !== "pi"
				|| !["idle", "done"].includes(ready.status?.state)) throw new Error("Sub Pi did not become ready for prompts.");
			await this.command("herdr-core", ["send", handle.terminalId, spec.task], signal, 70_000);
			return handle;
		} catch (error) {
			if (handle) {
				try { await this.close(handle); }
				catch (cleanup) { throw new HerdrLaunchCleanupError(handle, error, cleanup); }
			}
			throw error;
		} finally { fs.rmSync(launcher, { force: true }); }
	}

	async status(handle: SurfaceHandle | undefined): Promise<SubAgentStatus> {
		if (!handle?.terminalId) return "unknown";
		try {
			const info = await this.command("herdr-core", ["get", handle.terminalId], undefined, 3000);
			if (info.address !== handle.terminalId || info.state !== "live" || info.status?.app !== "pi") return "unknown";
			const state = info.status.state;
			return state === "done" ? "idle" : ["working", "idle", "blocked"].includes(state) ? state : "unknown";
		} catch { return "unknown"; }
	}

	async exists(handle: SurfaceHandle | undefined): Promise<boolean | undefined> {
		if (!handle?.terminalId) return undefined;
		try {
			const result = await this.pi.exec("herdr-core", ["get", handle.terminalId], { timeout: 3000 });
			if (result.killed) return undefined;
			const info = parse(result.stdout);
			if (result.code !== 0) return info.error?.kind === "not_found" ? false : undefined;
			if (info.address !== handle.terminalId) return undefined;
			return info.state === "live" ? true : info.state === "finished" ? false : undefined;
		} catch { return undefined; }
	}

	async close(handle: SurfaceHandle): Promise<void> {
		// Core removes any adopted pane too, without touching Main's tab or other panes.
		if (handle.terminalId && await this.exists(handle) !== false) {
			await this.command("herdr-core", ["kill", handle.terminalId]);
		}

	}
}
