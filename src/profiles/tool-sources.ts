import * as fs from "node:fs";
import * as path from "node:path";
import type { ResolvedProfile } from "./types.js";
import { isMcpTool, MCP_EXTENSIONS } from "./mcp.js";

const NATIVE_TOOLS = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);
const SUPPORTED_BUILTIN_EXTENSIONS = new Set<string>(MCP_EXTENSIONS);

interface ToolSource {
	name: string;
	sourceInfo: {
		path: string;
		source: string;
	};
}

export function resolveToolExtensions(profile: ResolvedProfile, tools: ToolSource[]): ResolvedProfile {
	const available = new Map(tools.map((tool) => [tool.name, tool]));
	const extensionPaths = new Set<string>();
	for (const name of profile.tools) {
		// Native MCP connects asynchronously; do not require its tools in Main yet.
		if (isMcpTool(name)) continue;
		const tool = available.get(name);
		if (!tool) throw new Error(`Profile '${profile.name}' references unavailable tool '${name}'.`);
		const sourcePath = tool.sourceInfo.path;
		if (tool.sourceInfo.source === "builtin") {
			if (NATIVE_TOOLS.has(name) && (sourcePath === `builtin:${name}` || sourcePath === `<builtin:${name}>`)) continue;
			if (!SUPPORTED_BUILTIN_EXTENSIONS.has(sourcePath)) {
				throw new Error(`Profile '${profile.name}' tool '${name}' requires unsupported isolated built-in extension '${sourcePath}'.`);
			}
			extensionPaths.add(sourcePath);
			continue;
		}
		if (tool.sourceInfo.source === "sdk" || !sourcePath || sourcePath.startsWith("<")) {
			throw new Error(`Profile '${profile.name}' tool '${name}' cannot be loaded in an isolated Sub process.`);
		}
		let stat: fs.Stats;
		try {
			stat = fs.statSync(sourcePath);
		} catch {
			throw new Error(`Profile '${profile.name}' tool '${name}' extension is missing: ${sourcePath}.`);
		}
		if (!stat.isFile() && !stat.isDirectory()) {
			throw new Error(`Profile '${profile.name}' tool '${name}' has an unsupported extension path: ${sourcePath}.`);
		}
		extensionPaths.add(path.resolve(sourcePath));
	}
	return { ...profile, resolvedExtensions: [...extensionPaths] };
}
