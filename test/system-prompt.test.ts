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
	applyStartupPromptSections(sections, profile(), "Available Pi Subagent profiles");
	assert.deepEqual(sections, {
		...nativeSections,
		subagent_profiles: "Available Pi Subagent profiles",
		subagent_profile: "## Active Pi Subagent profile: reviewer\nFollow the profile instructions.",
	});
	applyStartupPromptSections(sections, profile(), "Available Pi Subagent profiles");
	assert.equal(sections.subagent_profile.split("Follow the profile instructions.").length, 2);
});

test("contributes only through normal prompt assembly without a request-local fallback", () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	const pi = { on: (event: string, callback: (...args: any[]) => any) => handlers.set(event, callback) } as unknown as ExtensionAPI;
	let instructions = "Role instructions";
	bindPromptSections(pi, ["subagent_profile"], () => ({ subagent_profile: instructions }));
	assert.deepEqual([...handlers.keys()], ["before_agent_start"]);
	const sections: Record<string, string> = { ...nativeSections };
	handlers.get("before_agent_start")!({ systemPromptOptions: { sections } });
	assert.deepEqual(sections, { ...nativeSections, subagent_profile: instructions });
	instructions = "";
	handlers.get("before_agent_start")!({ systemPromptOptions: { sections } });
	assert.deepEqual(sections, nativeSections);
});

test("a Main without a selected profile still receives the profile catalog", () => {
	const sections: Record<string, string> = {};
	applyStartupPromptSections(sections, undefined, "Available Pi Subagent profiles");
	assert.deepEqual(sections, { subagent_profiles: "Available Pi Subagent profiles" });
});

test("removes obsolete Pi Subagent sections without touching other extensions", () => {
	const sections: Record<string, string> = { ...nativeSections, subagent_profiles: "Old catalog", subagent_profile: "Old instructions" };
	applyStartupPromptSections(sections, undefined, "");
	assert.deepEqual(sections, nativeSections);
});

test("adds the mandatory Sub protocol and profile instructions without Main context", () => {
	const sections = { ...nativeSections } as Record<string, string>;
	applySubPromptSections(sections, profile());
	assert.equal(sections.subagent_profiles, undefined);
	assert.equal(sections.subagent_main, undefined);
	assert.deepEqual(sections, {
		...nativeSections,
		subagent_sub_protocol: SUB_PROTOCOL,
		subagent_profile: "## Pi Subagent profile: reviewer\nFollow the profile instructions.",
	});
});

test("a Sub without profile instructions still gets its protocol and no stale instructions", () => {
	const sections: Record<string, string> = { ...nativeSections, subagent_profile: "Old instructions" };
	applySubPromptSections(sections, profile({ instructions: undefined }));
	assert.deepEqual(sections, { ...nativeSections, subagent_sub_protocol: SUB_PROTOCOL });
});
