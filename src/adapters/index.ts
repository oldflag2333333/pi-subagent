import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HerdrTabAdapter } from "./herdr.js";
import type { SubAgentStatus, SurfaceHandle } from "../types.js";

export class AdapterRegistry {
	private readonly herdr: HerdrTabAdapter;

	constructor(pi: ExtensionAPI) {
		this.herdr = new HerdrTabAdapter(pi);
	}

	async resolve(): Promise<HerdrTabAdapter> {
		if (!(await this.herdr.available())) {
			throw new Error("Facets requires Herdr, but the Herdr adapter is unavailable.");
		}
		return this.herdr;
	}

	async status(handle: SurfaceHandle | undefined): Promise<SubAgentStatus> {
		return this.herdr.status(handle);
	}

	async exists(handle: SurfaceHandle | undefined): Promise<boolean | undefined> {
		return this.herdr.exists(handle);
	}

	async close(handle: SurfaceHandle | undefined): Promise<void> {
		if (!handle) return;
		await this.herdr.close(handle);
	}
}
