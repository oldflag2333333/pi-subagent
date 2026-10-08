import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { bindPromptSections } from "./profiles/system-prompt.js";

const MAIN_CONTEXT_FILE = "MAIN.md";
const MAX_MAIN_CONTEXT_BYTES = 256 * 1024;

export interface MainContextLoadResult {
	content: string;
	paths: string[];
	diagnostics: Array<{ path: string; message: string }>;
}

function ancestorDirectories(cwd: string): string[] {
	const directories: string[] = [];
	let current = path.resolve(cwd);
	while (true) {
		directories.push(current);
		const parent = path.dirname(current);
		if (parent === current) return directories;
		current = parent;
	}
}

export function globalMainContextPath(): string {
	return path.join(getAgentDir(), "facets", MAIN_CONTEXT_FILE);
}

export function projectMainContextPath(directory: string): string {
	return path.join(directory, CONFIG_DIR_NAME, "facets", MAIN_CONTEXT_FILE);
}

export function loadMainContext(cwd: string, includeProject: boolean): MainContextLoadResult {
	const candidates = [
		globalMainContextPath(),
		...(includeProject
			? ancestorDirectories(cwd).reverse().map((directory) => projectMainContextPath(directory))
			: []),
	];
	const sections: Array<{ path: string; content: string }> = [];
	const diagnostics: Array<{ path: string; message: string }> = [];
	const seen = new Set<string>();

	for (const candidate of candidates) {
		const sourcePath = path.resolve(candidate);
		if (seen.has(sourcePath)) continue;
		seen.add(sourcePath);
		try {
			const stat = fs.statSync(sourcePath);
			if (!stat.isFile()) throw new Error("MAIN.md must be a regular file");
			if (stat.size > MAX_MAIN_CONTEXT_BYTES) {
				throw new Error(`MAIN.md exceeds ${MAX_MAIN_CONTEXT_BYTES} bytes`);
			}
			const content = fs.readFileSync(sourcePath, "utf8").trim();
			if (content) sections.push({ path: sourcePath, content });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			diagnostics.push({ path: sourcePath, message: error instanceof Error ? error.message : String(error) });
		}
	}

	return {
		content: sections
			.map((section) => `## Facets Main context: ${section.path}\n\n${section.content}`)
			.join("\n\n"),
		paths: sections.map((section) => section.path),
		diagnostics,
	};
}

export class MainContextRuntime {
	private content = "";

	constructor(private readonly pi: ExtensionAPI) {}

	register(): void {
		this.pi.on("session_start", (_event, ctx) => {
			const loaded = loadMainContext(ctx.cwd, ctx.isProjectTrusted());
			this.content = loaded.content;
			for (const diagnostic of loaded.diagnostics) {
				const message = `Facets Main context error (${diagnostic.path}): ${diagnostic.message}`;
				ctx.ui.notify(message, "warning");
				if (!ctx.hasUI) console.error(message);
			}
		});

		bindPromptSections(this.pi, ["facets_main"], (): Record<string, string> => this.content ? { facets_main: this.content } : {});
	}
}
