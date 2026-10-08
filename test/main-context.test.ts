import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	globalMainContextPath,
	loadMainContext,
	MainContextRuntime,
	projectMainContextPath,
} from "../src/main-context.js";

let root: string;
let cwd: string;
let previousAgentDir: string | undefined;

function write(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-facets-main-context-"));
	cwd = path.join(root, "project", "workspace", "requirement");
	fs.mkdirSync(cwd, { recursive: true });
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	fs.rmSync(root, { recursive: true, force: true });
});

test("loads global and trusted ancestor MAIN.md files from broadest to nearest", () => {
	const project = path.join(root, "project");
	const workspace = path.join(project, "workspace");
	write(globalMainContextPath(), "global main rule\n");
	write(projectMainContextPath(project), "project main rule\n");
	write(projectMainContextPath(workspace), "workspace main rule\n");

	const loaded = loadMainContext(cwd, true);
	assert.deepEqual(loaded.paths, [
		globalMainContextPath(),
		projectMainContextPath(project),
		projectMainContextPath(workspace),
	]);
	assert.equal(loaded.diagnostics.length, 0);
	assert.ok(loaded.content.indexOf("global main rule") < loaded.content.indexOf("project main rule"));
	assert.ok(loaded.content.indexOf("project main rule") < loaded.content.indexOf("workspace main rule"));
});

test("contributes MAIN.md through a section, without reading or replacing the full prompt", async () => {
	write(globalMainContextPath(), "global main rule");
	const handlers = new Map<string, (...args: any[]) => unknown>();
	const pi = { on: (event: string, handler: (...args: any[]) => unknown) => { handlers.set(event, handler); } } as unknown as ExtensionAPI;
	new MainContextRuntime(pi).register();
	const ctx = { cwd, isProjectTrusted: () => false, hasUI: false, ui: { notify: () => {} } } as unknown as ExtensionContext;
	await handlers.get("session_start")!({}, ctx);
	const sections: Record<string, string> = { unrelated_extension: "Keep me" };
	const event = { systemPromptOptions: { sections }, get systemPrompt(): string { throw new Error("Do not read the full prompt"); } };
	assert.equal(handlers.get("before_agent_start")!(event, ctx), undefined);
	assert.match(sections.facets_main!, /global main rule/);
	assert.equal(sections.unrelated_extension, "Keep me");
	fs.rmSync(globalMainContextPath());
	await handlers.get("session_start")!({}, ctx);
	handlers.get("before_agent_start")!(event, ctx);
	assert.deepEqual(sections, { unrelated_extension: "Keep me" });
});

test("does not load project MAIN.md files when project resources are untrusted", () => {
	write(globalMainContextPath(), "global main rule\n");
	write(projectMainContextPath(path.join(root, "project")), "project main rule\n");

	const loaded = loadMainContext(cwd, false);
	assert.deepEqual(loaded.paths, [globalMainContextPath()]);
	assert.match(loaded.content, /global main rule/);
	assert.doesNotMatch(loaded.content, /project main rule/);
});
