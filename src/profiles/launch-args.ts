import type { ResolvedProfile } from "./types.js";
import { isMcpTool, MCP_EXTENSIONS, MCP_TOOL_SELECTION } from "./mcp.js";

export const SUB_CONTROL_TOOLS = ["talk"] as const;

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

export function subCapabilityArgs(profile: ResolvedProfile, facetsEntryPath: string): string[] {
	const args: string[] = [];
	for (const extension of unique([...profile.resolvedExtensions, ...MCP_EXTENSIONS]).filter((entry) => entry !== facetsEntryPath)) {
		args.push("-e", extension);
	}
	args.push("--tools", unique([...profile.tools.filter((name) => !isMcpTool(name)), ...SUB_CONTROL_TOOLS, ...MCP_TOOL_SELECTION]).join(","));
	if (profile.model) args.push("--model", profile.model);
	if (profile.thinkingLevel) args.push("--thinking", profile.thinkingLevel);
	args.push("--no-skills");
	for (const skill of profile.resolvedSkills) args.push("--skill", skill);
	return args;
}
