import assert from "node:assert/strict";
import { test } from "node:test";
import { subCapabilityArgs } from "../src/profiles/launch-args.js";
import type { ResolvedProfile } from "../src/profiles/types.js";

const profile: ResolvedProfile = {
	version: 1,
	name: "reviewer",
	source: "global",
	sourcePath: "/tmp/reviewer.json",
	model: "provider/model/name",
	thinkingLevel: "provider-level",
	tools: ["read", "talk"],
	skills: ["review"],
	resolvedSkills: ["/tmp/review/SKILL.md"],
	resolvedExtensions: ["/tmp/web-extension.ts"],
};

test("keeps built-in extension specs intact and deduplicates explicit loads", () => {
	const args = subCapabilityArgs({
		...profile,
		tools: ["read", "codemode", "tool_search"],
		resolvedExtensions: ["builtin:codemode", "builtin:tool-search", "builtin:codemode", "/tmp/facets.ts"],
	}, "/tmp/facets.ts");
	assert.deepEqual(args.slice(0, 8), ["-e", "builtin:codemode", "-e", "builtin:tool-search", "-e", "builtin:mcp", "--tools", "read,codemode,tool_search,talk,mcp__*,list_mcp_resources,list_mcp_resource_templates,read_mcp_resource"]);
});

test("builds one Sub capability argument set from the resolved profile", () => {
	assert.deepEqual(subCapabilityArgs(profile, "/tmp/facets.ts"), [
		"-e", "/tmp/web-extension.ts",
		"-e", "builtin:codemode", "-e", "builtin:tool-search", "-e", "builtin:mcp",
		"--tools", "read,talk,codemode,tool_search,mcp__*,list_mcp_resources,list_mcp_resource_templates,read_mcp_resource",
		"--model", "provider/model/name",
		"--thinking", "provider-level",
		"--no-skills",
		"--skill", "/tmp/review/SKILL.md",
	]);
});
