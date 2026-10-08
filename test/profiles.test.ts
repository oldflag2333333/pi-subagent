import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
	globalProfilesDir,
	loadProfiles,
	projectProfilesDir,
	resolveProfile,
} from "../src/profiles/loader.js";

let root: string;
let cwd: string;
let previousAgentDir: string | undefined;
let previousRuntimeDir: string | undefined;

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeDirectoryProfile(rootDir: string, name: string, value: unknown): string {
	const profileDir = path.join(rootDir, name);
	writeJson(path.join(profileDir, "config.json"), value);
	return profileDir;
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-facets-profiles-"));
	cwd = path.join(root, "project");
	fs.mkdirSync(cwd);
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
	process.env.XDG_RUNTIME_DIR = path.join(root, "runtime");
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
	else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
	fs.rmSync(root, { recursive: true, force: true });
});

test("validates manual invocation while keeping operator discovery separate from delegation", () => {
	writeJson(path.join(globalProfilesDir(), "review.json"), {
		version: 1, name: "review", invocation: "manual", sessionPersistence: "persistent", tools: ["read"],
	});
	writeJson(path.join(globalProfilesDir(), "oracle.json"), { version: 1, name: "oracle", tools: ["read"] });
	assert.equal(resolveProfile("review", cwd, false).invocation, "manual");
	assert.throws(() => resolveProfile("review", cwd, false, { agentOnly: true }), /user-invoked only/);
	assert.throws(() => resolveProfile("missing", cwd, false, { agentOnly: true }), (error: unknown) => {
		assert.match(String(error), /oracle/);
		assert.doesNotMatch(String(error), /review/);
		return true;
	});
	writeJson(path.join(globalProfilesDir(), "bad.json"), { version: 1, name: "bad", invocation: "hidden", tools: ["read"] });
	assert.match(loadProfiles(cwd, false).diagnostics[0]!.message, /invocation/);
});

test("loads global profiles without applying an internal thinking-level enum", () => {
	writeJson(path.join(globalProfilesDir(), "reviewer.json"), {
		version: 1,
		name: "reviewer",
		tools: ["read", "grep"],
		thinkingLevel: "provider-defined-level",
	});
	const catalog = loadProfiles(cwd, false);
	assert.equal(catalog.diagnostics.length, 0);
	assert.equal(catalog.profiles.get("reviewer")?.source, "global");
	assert.equal(catalog.profiles.get("reviewer")?.thinkingLevel, "provider-defined-level");
});

test("loads directory profiles with additive instructions", () => {
	const profileDir = writeDirectoryProfile(globalProfilesDir(), "reviewer", {
		version: 1, name: "reviewer", tools: ["read"], instructions: "Append these instructions.",
	});
	const profile = loadProfiles(cwd, false).profiles.get("reviewer");
	assert.equal(profile?.sourcePath, path.join(profileDir, "config.json"));
	assert.equal(profile?.instructions, "Append these instructions.");
});

test("prefers instructions.md over inline instructions and preserves Markdown verbatim", () => {
	const profileDir = writeDirectoryProfile(globalProfilesDir(), "reviewer", {
		version: 1, name: "reviewer", tools: ["read"], instructions: "Inline fallback.",
	});
	const instructions = "# Reviewer\n\nReview only.\n保持只读。\n";
	fs.writeFileSync(path.join(profileDir, "instructions.md"), instructions);
	const catalog = loadProfiles(cwd, false);
	assert.deepEqual(catalog.diagnostics, []);
	assert.equal(catalog.profiles.get("reviewer")?.instructions, instructions);
	assert.equal(resolveProfile("reviewer", cwd, false).instructions, instructions);
	fs.unlinkSync(path.join(profileDir, "instructions.md"));
	assert.equal(resolveProfile("reviewer", cwd, false).instructions, "Inline fallback.");
});

test("loads file-only instructions and picks up changes on reload", () => {
	const profileDir = writeDirectoryProfile(globalProfilesDir(), "reviewer", {
		version: 1, name: "reviewer", tools: ["read"],
	});
	const file = path.join(profileDir, "instructions.md");
	fs.writeFileSync(file, "First role.");
	const snapshot = resolveProfile("reviewer", cwd, false);
	assert.equal(snapshot.instructions, "First role.");
	fs.writeFileSync(file, "Updated role.");
	assert.equal(resolveProfile("reviewer", cwd, false).instructions, "Updated role.");
	assert.equal(snapshot.instructions, "First role.");
});

test("does not share instructions.md with legacy or sibling profiles", () => {
	writeJson(path.join(globalProfilesDir(), "legacy.json"), {
		version: 1, name: "legacy", tools: ["read"], instructions: "Legacy inline.",
	});
	fs.writeFileSync(path.join(globalProfilesDir(), "instructions.md"), "Shared instructions must not load.");
	const profileDir = writeDirectoryProfile(globalProfilesDir(), "reviewer", {
		version: 1, name: "reviewer", tools: ["read"],
	});
	fs.writeFileSync(path.join(profileDir, "instructions.md"), "Reviewer only.");
	writeDirectoryProfile(globalProfilesDir(), "writer", { version: 1, name: "writer", tools: ["read"] });
	const catalog = loadProfiles(cwd, false);
	assert.deepEqual(catalog.diagnostics, []);
	assert.equal(catalog.profiles.get("legacy")?.instructions, "Legacy inline.");
	assert.equal(catalog.profiles.get("writer")?.instructions, undefined);
});

test("instructions files follow project trust and whole-profile overrides", () => {
	const globalDir = writeDirectoryProfile(globalProfilesDir(), "reviewer", {
		version: 1, name: "reviewer", tools: ["read"],
	});
	fs.writeFileSync(path.join(globalDir, "instructions.md"), "Global role.");
	const projectDir = writeDirectoryProfile(projectProfilesDir(cwd), "reviewer", {
		version: 1, name: "reviewer", tools: ["read"], instructions: "Project inline.",
	});
	assert.equal(resolveProfile("reviewer", cwd, true).instructions, "Project inline.");
	fs.writeFileSync(path.join(projectDir, "instructions.md"), "Project file.");
	assert.equal(resolveProfile("reviewer", cwd, false).instructions, "Global role.");
	assert.equal(resolveProfile("reviewer", cwd, true).instructions, "Project file.");
});

for (const [label, content, message] of [
	["empty", " \n\t", /non-empty/],
	["too many characters", "a".repeat(65537), /65536 characters/],
	["too many bytes", "a".repeat(256 * 1024 + 1), /maximum byte size/],
	["directory", undefined, /regular file/],
] as const) {
	test(`rejects ${label} instructions.md without falling back to inline or global instructions`, () => {
		writeJson(path.join(globalProfilesDir(), "reviewer.json"), {
			version: 1, name: "reviewer", tools: ["read"], instructions: "Global fallback.",
		});
		const profileDir = writeDirectoryProfile(projectProfilesDir(cwd), "reviewer", {
			version: 1, name: "reviewer", tools: ["read"], instructions: "Inline fallback.",
		});
		const file = path.join(profileDir, "instructions.md");
		if (content === undefined) fs.mkdirSync(file);
		else fs.writeFileSync(file, content);
		const catalog = loadProfiles(cwd, true);
		assert.equal(catalog.profiles.has("reviewer"), false);
		assert.equal(catalog.diagnostics.length, 1);
		assert.equal(catalog.diagnostics[0]?.path, file);
		assert.match(catalog.diagnostics[0]!.message, message);
	});
}

test("accepts multi-byte instructions at the character limit", () => {
	const profileDir = writeDirectoryProfile(globalProfilesDir(), "reviewer", {
		version: 1, name: "reviewer", tools: ["read"],
	});
	const instructions = "读".repeat(65536);
	fs.writeFileSync(path.join(profileDir, "instructions.md"), instructions);
	assert.equal(resolveProfile("reviewer", cwd, false).instructions, instructions);
});

test("rejects duplicate file and directory definitions in the same scope", () => {
	writeJson(path.join(globalProfilesDir(), "reviewer.json"), {
		version: 1,
		name: "reviewer",
		tools: ["read"],
	});
	writeDirectoryProfile(globalProfilesDir(), "reviewer", {
		version: 1,
		name: "reviewer",
		tools: ["read", "grep"],
	});
	const catalog = loadProfiles(cwd, false);
	assert.equal(catalog.profiles.has("reviewer"), false);
	assert.match(catalog.diagnostics[0]?.message ?? "", /duplicate profile/);
});

test("loads persistent session configuration and rejects unknown values", () => {
	writeJson(path.join(globalProfilesDir(), "persistent.json"), {
		version: 1,
		name: "persistent",
		tools: ["read"],
		sessionPersistence: "persistent",
	});
	writeJson(path.join(globalProfilesDir(), "invalid.json"), {
		version: 1,
		name: "invalid",
		tools: ["read"],
		sessionPersistence: "forever",
	});
	const catalog = loadProfiles(cwd, false);
	assert.equal(catalog.profiles.get("persistent")?.sessionPersistence, "persistent");
	assert.equal(catalog.profiles.has("invalid"), false);
	assert.match(catalog.diagnostics[0]?.message ?? "", /sessionPersistence/);
});

test("trusted project profiles override same-named global profiles", () => {
	writeJson(path.join(globalProfilesDir(), "reviewer.json"), {
		version: 1,
		name: "reviewer",
		tools: ["read"],
	});
	writeJson(path.join(projectProfilesDir(cwd), "reviewer.json"), {
		version: 1,
		name: "reviewer",
		tools: ["read", "grep"],
	});
	assert.deepEqual(loadProfiles(cwd, false).profiles.get("reviewer")?.tools, ["read"]);
	const trusted = loadProfiles(cwd, true).profiles.get("reviewer");
	assert.equal(trusted?.source, "project");
	assert.deepEqual(trusted?.tools, ["read", "grep"]);
});

test("loads ancestor profiles and lets the nearest directory override them", () => {
	const nestedCwd = path.join(cwd, "workspace", "requirement");
	fs.mkdirSync(nestedCwd, { recursive: true });
	writeJson(path.join(projectProfilesDir(cwd), "reviewer.json"), {
		version: 1,
		name: "reviewer",
		tools: ["read"],
	});
	writeJson(path.join(projectProfilesDir(path.join(cwd, "workspace")), "reviewer.json"), {
		version: 1,
		name: "reviewer",
		tools: ["read", "grep"],
	});

	const profile = loadProfiles(nestedCwd, true).profiles.get("reviewer");
	assert.equal(profile?.sourcePath, path.join(projectProfilesDir(path.join(cwd, "workspace")), "reviewer.json"));
	assert.deepEqual(profile?.tools, ["read", "grep"]);
});

test("resolves configured skill names to concrete SKILL.md paths", () => {
	const skill = path.join(process.env.PI_CODING_AGENT_DIR!, "skills", "code-review", "SKILL.md");
	fs.mkdirSync(path.dirname(skill), { recursive: true });
	fs.writeFileSync(skill, "---\nname: code-review\ndescription: Review code\n---\n");
	writeJson(path.join(globalProfilesDir(), "reviewer.json"), {
		version: 1,
		name: "reviewer",
		tools: ["read"],
		skills: ["code-review"],
	});
	assert.deepEqual(resolveProfile("reviewer", cwd, false).resolvedSkills, [skill]);
});

test("passes explicitly selected manual skills through unchanged without runtime mirrors", () => {
	const skillDir = path.join(process.env.PI_CODING_AGENT_DIR!, "skills", "manual-review");
	const skill = path.join(skillDir, "SKILL.md");
	const source = "---\nname: manual-review\ndescription: Review manually\ndisable-model-invocation: true\n---\n\nRead [guide](guide.md).\n";
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(skill, source);
	fs.writeFileSync(path.join(skillDir, "guide.md"), "review guide\n");
	writeJson(path.join(globalProfilesDir(), "reviewer.json"), {
		version: 1,
		name: "reviewer",
		tools: ["read"],
		skills: ["manual-review"],
	});

	const [resolved] = resolveProfile("reviewer", cwd, false).resolvedSkills;
	assert.ok(resolved);
	assert.equal(resolved, skill);
	assert.equal(fs.existsSync(process.env.XDG_RUNTIME_DIR!), false);
	assert.equal(fs.readFileSync(skill, "utf8"), source);
	assert.equal(fs.readFileSync(path.join(path.dirname(resolved), "guide.md"), "utf8"), "review guide\n");
});

test("resolves skill names from ancestor project directories", () => {
	const nestedCwd = path.join(cwd, "workspace", "requirement");
	fs.mkdirSync(nestedCwd, { recursive: true });
	const skill = path.join(cwd, ".agents", "skills", "project-review", "SKILL.md");
	fs.mkdirSync(path.dirname(skill), { recursive: true });
	fs.writeFileSync(skill, "---\nname: project-review\ndescription: Review this project\n---\n");
	writeJson(path.join(projectProfilesDir(cwd), "reviewer.json"), {
		version: 1,
		name: "reviewer",
		tools: ["read"],
		skills: ["project-review"],
	});

	assert.deepEqual(resolveProfile("reviewer", nestedCwd, true).resolvedSkills, [skill]);
});

test("does not discover named skills in untrusted projects or ancestors", () => {
	const nestedCwd = path.join(cwd, "workspace");
	fs.mkdirSync(nestedCwd);
	writeJson(path.join(globalProfilesDir(), "reviewer.json"), {
		version: 1, name: "reviewer", tools: ["read"], skills: ["facets-test-project-only"],
	});
	for (const location of [".pi", ".agents"]) {
		const skill = path.join(cwd, location, "skills", "facets-test-project-only", "SKILL.md");
		fs.mkdirSync(path.dirname(skill), { recursive: true });
		fs.writeFileSync(skill, "---\nname: facets-test-project-only\ndescription: Project only\n---\n");
		assert.throws(() => resolveProfile("reviewer", nestedCwd, false), /unknown skill/);
		assert.ok(resolveProfile("reviewer", nestedCwd, true).resolvedSkills.includes(skill));
		fs.rmSync(path.dirname(skill), { recursive: true });
	}
});

test("retains user-selected explicit skill paths without project discovery", () => {
	const skill = path.join(cwd, ".pi", "skills", "explicit", "SKILL.md");
	fs.mkdirSync(path.dirname(skill), { recursive: true });
	fs.writeFileSync(skill, "---\nname: explicit\ndescription: Explicit choice\n---\n");
	for (const reference of [skill, path.relative(globalProfilesDir(), skill)]) {
		writeJson(path.join(globalProfilesDir(), "reviewer.json"), {
			version: 1, name: "reviewer", tools: ["read"], skills: [reference],
		});
		assert.deepEqual(resolveProfile("reviewer", cwd, false).resolvedSkills, [skill]);
	}
});

function writeSkill(file: string, name = "private-review", manual = false): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `---\nname: ${name}\ndescription: Private review\ndisable-model-invocation: ${manual}\n---\n`);
	return file;
}

test("automatically discovers private skills, merges explicit skills, and deduplicates paths", () => {
	const dir = writeDirectoryProfile(globalProfilesDir(), "reviewer", {
		version: 1, name: "reviewer", tools: ["read"],
		skills: ["./skills/review", "shared"],
	});
	const privateSkill = writeSkill(path.join(dir, "skills", "review", "SKILL.md"));
	writeSkill(path.join(dir, "skills", "review", "assets", "SKILL.md"), "asset");
	const standalone = writeSkill(path.join(dir, "skills", "standalone.md"), "standalone");
	const nested = writeSkill(path.join(dir, "skills", "group", "nested", "SKILL.md"), "nested");
	const shared = writeSkill(path.join(process.env.PI_CODING_AGENT_DIR!, "skills", "shared", "SKILL.md"), "shared");
	fs.symlinkSync(path.join(dir, "skills"), path.join(dir, "skills", "loop"), "dir");
	const other = writeDirectoryProfile(globalProfilesDir(), "writer", { version: 1, name: "writer", tools: ["read"] });
	writeSkill(path.join(other, "skills", "writer", "SKILL.md"), "writer");
	assert.deepEqual(resolveProfile("reviewer", cwd, false).resolvedSkills, [nested, privateSkill, standalone, shared]);
});

test("private skills follow profile overrides and project trust without inheritance", () => {
	const definition = { version: 1, name: "reviewer", tools: ["read"] };
	const global = writeDirectoryProfile(globalProfilesDir(), "reviewer", definition);
	const globalSkill = writeSkill(path.join(global, "skills", "global", "SKILL.md"), "global");
	const project = writeDirectoryProfile(projectProfilesDir(cwd), "reviewer", definition);
	const projectSkill = writeSkill(path.join(project, "skills", "project", "SKILL.md"), "project");
	const nestedCwd = path.join(cwd, "workspace");
	fs.mkdirSync(nestedCwd);
	assert.deepEqual(resolveProfile("reviewer", nestedCwd, false).resolvedSkills, [globalSkill]);
	assert.deepEqual(resolveProfile("reviewer", nestedCwd, true).resolvedSkills, [projectSkill]);
	fs.rmSync(path.join(project, "skills"), { recursive: true });
	assert.deepEqual(resolveProfile("reviewer", nestedCwd, true).resolvedSkills, []);
});

test("legacy profiles do not automatically load a shared sibling skills directory", () => {
	writeJson(path.join(globalProfilesDir(), "reviewer.json"), { version: 1, name: "reviewer", tools: ["read"] });
	writeSkill(path.join(globalProfilesDir(), "skills", "private", "SKILL.md"));
	assert.deepEqual(resolveProfile("reviewer", cwd, false).resolvedSkills, []);
});

test("passes private manual skills through unchanged without runtime mirrors", () => {
	const dir = writeDirectoryProfile(globalProfilesDir(), "reviewer", { version: 1, name: "reviewer", tools: ["read"] });
	const skill = writeSkill(path.join(dir, "skills", "review", "SKILL.md"), "review", true);
	fs.writeFileSync(path.join(path.dirname(skill), "guide.md"), "private guide");
	const [resolved] = resolveProfile("reviewer", cwd, false).resolvedSkills;
	assert.ok(resolved);
	assert.equal(resolved, skill);
	assert.equal(fs.existsSync(process.env.XDG_RUNTIME_DIR!), false);
	assert.match(fs.readFileSync(resolved, "utf8"), /disable-model-invocation: true/);
	assert.equal(fs.readFileSync(path.join(path.dirname(resolved), "guide.md"), "utf8"), "private guide");
});

test("reports invalid profiles and does not load them", () => {
	writeJson(path.join(globalProfilesDir(), "wrong-name.json"), {
		version: 1,
		name: "reviewer",
		tools: ["read"],
	});
	const catalog = loadProfiles(cwd, false);
	assert.equal(catalog.profiles.size, 0);
	assert.match(catalog.diagnostics[0]?.message ?? "", /must match profile entry/);
});

test("an invalid directory project override does not silently fall back to a global profile", () => {
	writeJson(path.join(globalProfilesDir(), "reviewer.json"), {
		version: 1,
		name: "reviewer",
		tools: ["read"],
	});
	writeDirectoryProfile(projectProfilesDir(cwd), "reviewer", {
		version: 1,
		name: "wrong-name",
		tools: ["read", "bash"],
	});
	const catalog = loadProfiles(cwd, true);
	assert.equal(catalog.profiles.has("reviewer"), false);
	assert.throws(() => resolveProfile("reviewer", cwd, true), /Invalid profiles/);
});
