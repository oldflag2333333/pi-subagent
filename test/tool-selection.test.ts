import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyProfileTools } from "../src/profiles/tool-selection.js";

test("selects the profile's model-facing tools without installing execution guards", () => {
	let selected = ["read", "write"];
	const pi = {
		on: () => { assert.fail("Tool selection must not register permission hooks"); },
		getAllTools: () => [{ name: "read" }, { name: "write" }, { name: "extra", exposure: "deferred" }],
		setActiveTools: (tools: string[]) => { selected = tools; },
		getActiveTools: () => selected,
	} as unknown as ExtensionAPI;
	const tools = ["read"];
	applyProfileTools(pi, "reviewer", tools);
	assert.deepEqual(selected, ["read"]);
	tools.push("write");
	assert.deepEqual(selected, ["read"]);
});

test("preserves native MCP visibility without waiting for profile MCP names", () => {
	let selected = ["write", "codemode", "tool_search", "mcp__ambient__direct", "read_mcp_resource"];
	const pi = {
		getAllTools: () => selected.map((name) => ({ name })).concat([{ name: "read" }]),
		getActiveTools: () => selected,
		setActiveTools: (tools: string[]) => { selected = tools; },
	} as unknown as ExtensionAPI;
	applyProfileTools(pi, "reviewer", ["read", "mcp__connecting__tool"]);
	assert.deepEqual(selected, ["read", "codemode", "tool_search", "mcp__ambient__direct", "read_mcp_resource"]);
});

test("checks both registration and effective activation before accepting profile tools", () => {
	let selected: string[] = [];
	const pi = {
		getAllTools: () => [{ name: "read" }, { name: "hidden", exposure: "hidden" }],
		setActiveTools: (tools: string[]) => { selected = tools; },
		getActiveTools: () => selected,
	} as unknown as ExtensionAPI;
	assert.throws(() => applyProfileTools(pi, "reviewer", ["missing"]), /unavailable tools: missing/);
	assert.throws(() => applyProfileTools(pi, "reviewer", ["hidden"]), /unavailable tools: hidden/);
	applyProfileTools(pi, "reviewer", ["read"]);
	assert.deepEqual(selected, ["read"]);
	pi.getActiveTools = () => [];
	assert.throws(() => applyProfileTools(pi, "reviewer", ["read"]), /could not activate tools: read/);
});
