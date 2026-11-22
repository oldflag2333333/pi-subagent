import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HerdrTabAdapter } from "./herdr.js";
import { HerdrCoreAdapter } from "./herdr-core.js";
import type { SubAgentStatus, SurfaceHandle } from "../types.js";

export class AdapterRegistry {
	private readonly herdr: HerdrTabAdapter;
	private readonly core: HerdrCoreAdapter;

	constructor(pi: ExtensionAPI) {
		this.herdr = new HerdrTabAdapter(pi);
		this.core = new HerdrCoreAdapter(pi);
	}

	async resolve(): Promise<HerdrTabAdapter | HerdrCoreAdapter> {
		if (process.env.HC_TERMINAL_ID) {
			if (await this.core.available()) return this.core;
			throw new Error("Pi Subagent requires a running herdr-core for this terminal.");
		}
		if (!(await this.herdr.available())) {
			throw new Error("Pi Subagent requires Herdr, but the Herdr adapter is unavailable.");
		}
		return this.herdr;
	}

	async status(handle: SurfaceHandle | undefined): Promise<SubAgentStatus> {
		return (handle?.backend === "core" ? this.core : this.herdr).status(handle);
	}

	async exists(handle: SurfaceHandle | undefined): Promise<boolean | undefined> {
		return (handle?.backend === "core" ? this.core : this.herdr).exists(handle);
	}

	async close(handle: SurfaceHandle | undefined): Promise<void> {
		if (!handle) return;
		await (handle.backend === "core" ? this.core : this.herdr).close(handle);
	}
}
