import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isMcpTool, isMcpContextTool } from "./mcp.js";

/** Select the model-facing tool set; profiles do not install execution guards. */
export function applyProfileTools(pi: ExtensionAPI, profileName: string, tools: readonly string[]): void {
	// Leave MCP visibility and discovery helpers as Pi configured them. Explicit
	// MCP names in a profile neither restrict servers nor delay Sub readiness.
	const selected = tools.filter((name) => !isMcpTool(name));
	const ambient = pi.getActiveTools().filter(isMcpContextTool);
	const available = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
	const unavailable = selected.filter((name) => !available.has(name) || available.get(name)?.exposure === "hidden");
	if (unavailable.length > 0) {
		throw new Error(`Profile '${profileName}' references unavailable tools: ${unavailable.join(", ")}.`);
	}
	pi.setActiveTools([...new Set([...selected, ...ambient])]);
	const active = new Set(pi.getActiveTools());
	const missing = selected.filter((name) => !active.has(name));
	if (missing.length > 0) {
		throw new Error(`Profile '${profileName}' could not activate tools: ${missing.join(", ")}.`);
	}
}
