import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { subSessionName } from "../manual-context.js";
import { subCapabilityArgs } from "../profiles/launch-args.js";
import { LAUNCH_COMMAND, launchScriptContent, launchScriptPath, reapAbandonedLaunchScripts } from "./launch-script.js";
import type { SubAgentStatus, SubLaunchSpec, SubSurfaceAdapter, SurfaceHandle } from "../types.js";

function parseEnvelope(stdout: string): Record<string, unknown> {
	const lines = stdout.trim().split(/\r?\n/).filter(Boolean).reverse();
	for (const line of lines) {
		try {
			const parsed = JSON.parse(line) as Record<string, unknown>;
			return parsed.result && typeof parsed.result === "object" ? parsed.result as Record<string, unknown> : parsed;
		} catch {}
	}
	throw new Error(`Herdr returned no JSON response: ${stdout.slice(0, 300)}`);
}

function nestedString(value: unknown, ...keys: string[]): string | undefined {
	let current: unknown = value;
	for (const key of keys) {
		if (!current || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return typeof current === "string" ? current : undefined;
}

function safeLabel(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 48) || "delegated task";
}

function agentName(runId: string): string {
	return `sub-${runId.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 20)}`;
}

function subArgs(spec: SubLaunchSpec): string[] {
	const herdrIntegration = path.join(getAgentDir(), "extensions", "herdr-agent-state.ts");
	return [
		"--no-extensions",
		"-e", spec.entryPath,
		...(fs.existsSync(herdrIntegration) ? ["-e", herdrIntegration] : []),
		...(spec.profile.sessionPersistence === "persistent"
			? (spec.sessionDir ? ["--session-dir", spec.sessionDir] : []) : ["--no-session"]),
		...(spec.resumeSessionFile ? ["--session", spec.resumeSessionFile] : ["--session-id", spec.sessionId]),
		spec.projectTrusted ? "--approve" : "--no-approve",
		"--name", subSessionName(safeLabel(spec.title), spec.origin),
		...subCapabilityArgs(spec.profile, spec.entryPath),
	];
}

/** A launch failed and its tab could not be rolled back; keep it addressable. */
export class HerdrLaunchCleanupError extends Error {
	constructor(readonly handle: SurfaceHandle, cause: unknown, cleanup: unknown) {
		super(`Sub launch failed: ${cause instanceof Error ? cause.message : String(cause)}. Tab cleanup also failed: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}.`, { cause });
	}
}

export class HerdrTabAdapter implements SubSurfaceAdapter {
	readonly id = "herdr" as const;
	constructor(private readonly pi: ExtensionAPI) {}

	async available(): Promise<boolean> {
		if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_WORKSPACE_ID) return false;
		const result = await this.pi.exec("herdr", ["status", "server"], { timeout: 3000 });
		return result.code === 0;
	}

	async launch(spec: SubLaunchSpec, signal?: AbortSignal): Promise<SurfaceHandle> {
		const workspaceId = process.env.HERDR_WORKSPACE_ID;
		if (!workspaceId) throw new Error("HERDR_WORKSPACE_ID is unavailable; Pi is not running in a Herdr workspace.");
		signal?.throwIfAborted();
		reapAbandonedLaunchScripts();
		const launcher = launchScriptPath(spec.channelDir);
		const label = `↳ pi · ${safeLabel(spec.title)}`;
		const created = await this.pi.exec("herdr", [
			"tab", "create",
			"--workspace", workspaceId,
			"--cwd", spec.cwd,
			"--label", label,
			"--env", "PI_SUBAGENT_ROLE=sub",
			"--env", `PI_SUBAGENT_CHANNEL=${spec.channelDir}`,
			"--env", `PI_SUBAGENT_TOKEN=${spec.token}`,
			"--env", `PI_SUBAGENT_LAUNCH=${launcher}`,
			"--no-focus",
		], { timeout: 15_000, signal });
		let payload: Record<string, unknown>;
		try { payload = parseEnvelope(created.stdout); } catch (error) {
			if (created.code !== 0 || created.killed) throw new Error(created.stderr || "Failed to create Herdr tab.");
			throw error;
		}
		const tabId = nestedString(payload, "tab", "tab_id") ?? nestedString(payload, "tab", "id");
		const paneId = nestedString(payload, "root_pane", "pane_id") ?? nestedString(payload, "pane", "pane_id");
		if (!tabId) throw new Error("Herdr tab creation response did not contain a tab ID; automatic cleanup is unavailable.");
		const handle: SurfaceHandle = { adapter: "herdr", tabId, ...(paneId ? { paneId } : {}) };
		const terminalId = nestedString(payload, "root_pane", "terminal_id") ?? nestedString(payload, "pane", "terminal_id");
		let launcherOwned = false;
		const removeLauncher = () => {
			if (!launcherOwned) return;
			fs.rmSync(launcher, { force: true });
			launcherOwned = false;
		};
		const step = async (args: string[], timeout: number, failure: string) => {
			signal?.throwIfAborted();
			const result = await this.pi.exec("herdr", args, { timeout, signal });
			signal?.throwIfAborted();
			if (result.code !== 0 || result.killed) throw new Error(result.stderr || failure);
		};
		try {
			if (created.code !== 0 || created.killed) throw new Error(created.stderr || "Failed to create Herdr tab.");
			if (!paneId) throw new Error("Herdr tab creation response did not contain a root pane ID.");
			// The file is private and exclusive; even a partial write is owned and
			// cleaned up on failure. Its path travels via tab env, not PTY input.
			const fd = fs.openSync(launcher, "wx", 0o600);
			launcherOwned = true;
			try { fs.writeFileSync(fd, launchScriptContent(subArgs(spec)), "utf8"); }
			finally { fs.closeSync(fd); }
			await step(["pane", "run", paneId, LAUNCH_COMMAND], 10_000, "Failed to launch Sub Pi in Herdr tab.");
			await this.waitForPi(handle, terminalId, signal);
			// pane run only acknowledges admission; never unlink on that alone.
			removeLauncher();
			const name = agentName(spec.runId);
			await step(["agent", "rename", paneId, name], 10_000, "Failed to name the Sub Pi agent.");
			await step([
				"pane", "report-metadata", paneId, "--source", "subagent",
				"--token", "subagent_role=sub", "--token", `subagent_main_session=${spec.mainSessionId}`,
				"--token", `subagent_run_id=${spec.runId}`, "--token", `subagent_profile=${spec.profile.name}`,
			], 10_000, "Failed to mark the Herdr pane as a Pi Subagent Sub.");
			await step(["agent", "prompt", name, spec.task], 20_000, "Failed to submit the delegated task to the Herdr agent.");
			return handle;
		} catch (error) {
			let rollback: unknown;
			try {
				// Rollback must not inherit the cancellation that caused the failure.
				await this.close(handle);
			} catch (cleanup) { rollback = cleanup; }
			try { removeLauncher(); }
			catch (cleanup) {
				error = new AggregateError([error, cleanup], `Sub launch failed: ${error instanceof Error ? error.message : String(error)}. Launch script cleanup also failed (${launcher}): ${cleanup instanceof Error ? cleanup.message : String(cleanup)}.`, { cause: error });
			}
			if (rollback) throw new HerdrLaunchCleanupError(handle, error, rollback);
			throw error;
		}
	}

	private async waitForPi(handle: SurfaceHandle, terminalId: string | undefined, signal?: AbortSignal): Promise<void> {
		const deadline = Date.now() + 60_000;
		while (true) {
			signal?.throwIfAborted();
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new Error("Sub Pi did not become ready within 60 seconds.");
			const response = await this.pi.exec("herdr", ["agent", "get", handle.paneId!], { timeout: Math.min(3000, remaining), signal });
			signal?.throwIfAborted();
			if (Date.now() >= deadline) throw new Error("Sub Pi did not become ready within 60 seconds.");
			if (response.killed) throw new Error(response.stderr || "Herdr agent readiness check was interrupted.");
			let payload: Record<string, unknown>;
			try { payload = parseEnvelope(`${response.stdout}\n${response.stderr}`); }
			catch (error) { throw new Error(response.stderr || "Invalid Herdr agent readiness response.", { cause: error }); }
			if (response.code !== 0) {
				if (nestedString(payload, "error", "code") !== "agent_not_found") {
					throw new Error(response.stderr || "Failed to inspect the starting Sub Pi agent.");
				}
			} else {
				const agent = payload.agent as Record<string, unknown> | undefined;
				if (!agent || typeof agent !== "object") throw new Error("Herdr readiness response did not contain an agent.");
				if (agent.pane_id !== handle.paneId || agent.tab_id !== handle.tabId
					|| (terminalId && agent.terminal_id !== terminalId)) throw new Error("The Sub Pi terminal changed during startup.");
				if (agent.agent && agent.agent !== "pi") throw new Error(`Expected Sub Pi, but Herdr detected ${agent.agent}.`);
				if (agent.agent_status === "blocked") throw new Error("Sub Pi is blocked during startup and is not ready for prompts.");
				// interactive_ready is a managed-agent-start-only field in Herdr.
				// Unmanaged Pi readiness comes from its lifecycle hook or UI detector.
				if (agent.agent === "pi" && !agent.launch_pending && (agent.agent_status === "idle" || agent.agent_status === "done")) return;
			}
			try { await delay(Math.max(0, Math.min(100, deadline - Date.now())), undefined, { signal }); }
			catch (error) { signal?.throwIfAborted(); throw error; }
		}
	}

	async status(handle: SurfaceHandle | undefined): Promise<SubAgentStatus> {
		if (!handle?.paneId) return "unknown";
		try {
			const response = await this.pi.exec("herdr", ["agent", "get", handle.paneId], { timeout: 3000 });
			if (response.code !== 0) return "unknown";
			const agent = parseEnvelope(response.stdout).agent;
			if (!agent || typeof agent !== "object") return "unknown";
			const info = agent as Record<string, unknown>;
			if (info.pane_id !== handle.paneId || (handle.tabId && info.tab_id !== handle.tabId)) return "unknown";
			return info.agent_status === "working" || info.agent_status === "blocked" || info.agent_status === "idle"
				? info.agent_status : "unknown";
		} catch {
			return "unknown";
		}
	}

	/** Distinguish an explicitly missing tab from a disconnected or unhealthy Herdr. */
	async exists(handle: SurfaceHandle | undefined): Promise<boolean | undefined> {
		if (!handle?.tabId) return undefined;
		try {
			const response = await this.pi.exec("herdr", ["tab", "get", handle.tabId], { timeout: 3000 });
			if (response.killed) return undefined;
			const payload = parseEnvelope(response.stdout);
			if (response.code !== 0) return nestedString(payload, "error", "code") === "tab_not_found" ? false : undefined;
			return nestedString(payload, "tab", "tab_id") === handle.tabId ? true : undefined;
		} catch { return undefined; }
	}

	async close(handle: SurfaceHandle): Promise<void> {
		if (!handle.tabId) return;
		const result = await this.pi.exec("herdr", ["tab", "close", handle.tabId], { timeout: 10_000 });
		if (result.code !== 0 || result.killed) throw new Error(result.stderr || `Failed to close Herdr tab ${handle.tabId}.`);
	}
}
