import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { resolveToolExtensions } from "../src/profiles/tool-sources.js";
import type { ResolvedProfile } from "../src/profiles/types.js";

function profile(tools: string[]): ResolvedProfile {
	return {
		version: 1,
		name: "research",
		tools,
		source: "global",
		sourcePath: "/tmp/research.json",
		resolvedSkills: [],
		resolvedExtensions: [],
	};
}

test("derives and deduplicates extension entry paths from selected tool provenance", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-facets-tool-source-"));
	try {
		const extension = path.join(root, "web.ts");
		fs.writeFileSync(extension, "export default () => {}\n");
		const resolved = resolveToolExtensions(profile(["read", "web_search", "fetch_content"]), [
			{ name: "read", sourceInfo: { path: "builtin:read", source: "builtin" } },
			{ name: "web_search", sourceInfo: { path: extension, source: "npm:pi-web-access" } },
			{ name: "fetch_content", sourceInfo: { path: extension, source: "npm:pi-web-access" } },
		]);
		assert.deepEqual(resolved.resolvedExtensions, [extension]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("loads built-in extensions explicitly while leaving native tools alone", () => {
	const resolved = resolveToolExtensions(profile(["read", "bash", "codemode", "tool_search"]), [
		{ name: "read", sourceInfo: { path: "builtin:read", source: "builtin" } },
		{ name: "bash", sourceInfo: { path: "<builtin:bash>", source: "builtin" } },
		{ name: "codemode", sourceInfo: { path: "builtin:codemode", source: "builtin" } },
		{ name: "tool_search", sourceInfo: { path: "builtin:tool-search", source: "builtin" } },
	]);
	assert.deepEqual(resolved.resolvedExtensions, ["builtin:codemode", "builtin:tool-search"]);
});

test("leaves MCP tools to Pi even before they connect in Main", () => {
	const selected = profile(["mcp__server__search", "read_mcp_resource"]);
	assert.deepEqual(resolveToolExtensions(selected, []).resolvedExtensions, []);
	assert.deepEqual(resolveToolExtensions(selected, [
		{ name: "mcp__server__search", sourceInfo: { path: "builtin:mcp", source: "builtin" } },
	]).resolvedExtensions, []);
});

test("still reports unsupported non-MCP built-in extensions", () => {
	assert.throws(
		() => resolveToolExtensions(profile(["unknown"]), [
			{ name: "unknown", sourceInfo: { path: "builtin:unknown", source: "builtin" } },
		]),
		/unsupported isolated built-in extension/,
	);
});

test("rejects tools whose implementation cannot be recreated in a Sub process", () => {
	assert.throws(
		() => resolveToolExtensions(profile(["sdk_tool"]), [
			{ name: "sdk_tool", sourceInfo: { path: "<sdk:sdk_tool>", source: "sdk" } },
		]),
		/cannot be loaded in an isolated Sub/,
	);
});
