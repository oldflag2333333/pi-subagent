import assert from "node:assert/strict";
import { test } from "node:test";
import { applySubPromptSections, applyStartupPromptSections, bindPromptSections, SUB_PROTOCOL } from "../src/profiles/system-prompt.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResolvedProfile } from "../src/profiles/types.js";

function profile(overrides: Partial<ResolvedProfile> = {}): ResolvedProfile {
	return {
		version: 1, name: "reviewer", tools: ["read"], instructions: "Follow the profile instructions.",
		source: "global", sourcePath: "/tmp/reviewer/config.json", resolvedSkills: [], resolvedExtensions: [], ...overrides,
	};
}

const nativeSections = { tools: "Native tools", rules: "Native rules", unrelated_extension: "Keep me" };

test("adds Main catalog and profile instructions as independent sections without replacing native content", () => {
	const sections = { ...nativeSections } as Record<string, string>;
	applyStartupPromptSections(sections, profile(), "Available Facets profiles");
	assert.deepEqual(sections, {
		...nativeSections,
		facets_profiles: "Available Facets profiles",
		facets_profile: "## Active Facets profile: reviewer\nFollow the profile instructions.",
	});
	applyStartupPromptSections(sections, profile(), "Available Facets profiles");
	assert.equal(sections.facets_profile.split("Follow the profile instructions.").length, 2);
});

test("contributes only through normal prompt assembly without a request-local fallback", () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	const pi = { on: (event: string, callback: (...args: any[]) => any) => handlers.set(event, callback) } as unknown as ExtensionAPI;
	let instructions = "Role instructions";
	bindPromptSections(pi, ["facets_profile"], () => ({ facets_profile: instructions }));
	assert.deepEqual([...handlers.keys()], ["before_agent_start"]);
	const sections: Record<string, string> = { ...nativeSections };
	handlers.get("before_agent_start")!({ systemPromptOptions: { sections } });
	assert.deepEqual(sections, { ...nativeSections, facets_profile: instructions });
	instructions = "";
	handlers.get("before_agent_start")!({ systemPromptOptions: { sections } });
	assert.deepEqual(sections, nativeSections);
});

test("a Main without a selected profile still receives the profile catalog", () => {
	const sections: Record<string, string> = {};
	applyStartupPromptSections(sections, undefined, "Available Facets profiles");
	assert.deepEqual(sections, { facets_profiles: "Available Facets profiles" });
});

test("removes obsolete Facets sections without touching other extensions", () => {
	const sections: Record<string, string> = { ...nativeSections, facets_profiles: "Old catalog", facets_profile: "Old instructions" };
	applyStartupPromptSections(sections, undefined, "");
	assert.deepEqual(sections, nativeSections);
});

test("adds the mandatory Sub protocol and profile instructions without Main context", () => {
	const sections = { ...nativeSections } as Record<string, string>;
	applySubPromptSections(sections, profile());
	assert.equal(sections.facets_profiles, undefined);
	assert.equal(sections.facets_main, undefined);
	assert.deepEqual(sections, {
		...nativeSections,
		facets_sub_protocol: SUB_PROTOCOL,
		facets_profile: "## Facets profile: reviewer\nFollow the profile instructions.",
	});
});

test("a Sub without profile instructions still gets its protocol and no stale instructions", () => {
	const sections: Record<string, string> = { ...nativeSections, facets_profile: "Old instructions" };
	applySubPromptSections(sections, profile({ instructions: undefined }));
	assert.deepEqual(sections, { ...nativeSections, facets_sub_protocol: SUB_PROTOCOL });
});
