// MCP is ambient Pi context, not selected or validated by a Facets profile.
export const MCP_EXTENSIONS = ["builtin:codemode", "builtin:tool-search", "builtin:mcp"] as const;
export const MCP_DISCOVERY_TOOLS = ["codemode", "tool_search"] as const;
const RESOURCE_TOOLS = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];

// Keep all MCP tools eligible for native registration/exposure, including tools
// discovered after startup. Tool-name patterns require Pi 1.0.4 or newer.
export const MCP_TOOL_SELECTION = [...MCP_DISCOVERY_TOOLS, "mcp__*", ...RESOURCE_TOOLS];

export function isMcpTool(name: string): boolean {
	return name.startsWith("mcp__") || RESOURCE_TOOLS.includes(name);
}

export function isMcpContextTool(name: string): boolean {
	return isMcpTool(name) || (MCP_DISCOVERY_TOOLS as readonly string[]).includes(name);
}
