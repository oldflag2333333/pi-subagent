import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { subSessionName } from "../manual-context.js";
import { subCapabilityArgs } from "../profiles/launch-args.js";
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
		...(spec.profile.sessionPersistence === "persistent" || spec.resumeSessionId ? [] : ["--no-session"]),
		...(spec.resumeSessionId ? ["--session", spec.resumeSessionId] : []),
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
		const label = `↳ pi · ${safeLabel(spec.title)}`;
		const created = await this.pi.exec("herdr", [
			"tab", "create",
			"--workspace", workspaceId,
			"--cwd", spec.cwd,
			"--label", label,
			"--env", "PI_FACETS_ROLE=sub",
			"--env", `PI_FACETS_CHANNEL=${spec.channelDir}`,
			"--env", `PI_FACETS_TOKEN=${spec.token}`,
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
		const step = async (args: string[], timeout: number, failure: string) => {
			signal?.throwIfAborted();
			const result = await this.pi.exec("herdr", args, { timeout, signal });
			if (result.code !== 0 || result.killed) throw new Error(result.stderr || failure);
			signal?.throwIfAborted();
		};
		try {
			if (created.code !== 0 || created.killed) throw new Error(created.stderr || "Failed to create Herdr tab.");
			if (!paneId) throw new Error("Herdr tab creation response did not contain a root pane ID.");
			const name = agentName(spec.runId);
			await step([
				"agent", "start", name, "--kind", "pi", "--pane", paneId, "--timeout", "60000", "--", ...subArgs(spec),
			], 70_000, "Failed to start Sub Pi in Herdr tab.");
			await step([
				"pane", "report-metadata", paneId, "--source", "facets",
				"--token", "facets_role=sub", "--token", `facets_main_session=${spec.mainSessionId}`,
				"--token", `facets_run_id=${spec.runId}`, "--token", `facets_profile=${spec.profile.name}`,
			], 10_000, "Failed to mark the Herdr pane as a Facets Sub.");
			await step(["agent", "prompt", name, spec.task], 20_000, "Failed to submit the delegated task to the Herdr agent.");
			return handle;
		} catch (error) {
			try {
				// Rollback must not inherit the cancellation that caused the failure.
				await this.close(handle);
			} catch (cleanup) {
				throw new HerdrLaunchCleanupError(handle, error, cleanup);
			}
			throw error;
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
