import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMainTools } from "../src/tools/main.js";

interface CapturedTool {
	name: string;
	exposure?: string;
	renderCall?: (args: unknown, theme: unknown, context: { expanded: boolean; state?: Record<string, unknown> }) => { render(width: number): string[] };
	renderResult?: (result: unknown, options: { isPartial: boolean }, theme: unknown, context?: { isError: boolean }) => { render(width: number): string[] };
	execute?: (_id: string, params: { all?: boolean }) => Promise<{ content: Array<{ text: string }>; details: unknown }>;
}

test("renders configured tools and skills under a Sub launch", () => {
	const tools: CapturedTool[] = [];
	const pi = { registerTool: (tool: CapturedTool) => tools.push(tool) } as unknown as ExtensionAPI;
	registerMainTools(pi, { runs: new Map() } as never);
	assert.deepEqual(tools.map((tool) => tool.name), ["delegate", "talk", "interrupt_sub", "close_sub", "list_sub"]);
	const delegate = tools.find((tool) => tool.name === "delegate");
	assert.ok(delegate?.renderCall);
	assert.ok(delegate.renderResult);
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const call = delegate.renderCall({ title: "Research topic", profile: "research" }, theme, { expanded: false })
		.render(240).join("\n");
	assert.match(call, /^delegate · Research topic/);
	const resumeCall = delegate.renderCall({ title: "Research topic", resumeSessionId: "session-id" }, theme, { expanded: false })
		.render(240).join("\n");
	assert.match(resumeCall, /^resume · Research topic/);
	const component = delegate.renderResult({
		details: {
			title: "Research topic",
			profile: "research",
			adapter: "herdr",
			sessionPersistence: "persistent",
			tools: ["web_search", "fetch_content"],
			skills: ["source-review"],
		},
	}, { isPartial: false }, theme, { isError: false });
	assert.equal(delegate.exposure, "model-only");
	assert.equal(tools.find((tool) => tool.name === "talk")?.exposure, undefined);
	const failure = delegate.renderResult({ content: [{ type: "text", text: "Cleanup failed; retry close_sub" }] }, { isPartial: false }, theme, { isError: true }).render(240).join("\n");
	assert.match(failure, /Cleanup failed/);
	assert.doesNotMatch(failure, /✓/);
	const rendered = component.render(240).join("\n");
	assert.match(rendered, /Research topic · research · persistent · herdr/);
	assert.match(rendered, /tools\s+web_search · fetch_content/);
	assert.match(rendered, /skills\s+source-review/);
	assert.doesNotMatch(rendered, /talk/);
});

test("renders talk message content", () => {
	const tools: CapturedTool[] = [];
	const pi = { registerTool: (tool: CapturedTool) => tools.push(tool) } as unknown as ExtensionAPI;
	const runs = new Map([["c3b22f28-abcd", { runId: "c3b22f28-abcd", title: "Review MR" }]]);
	registerMainTools(pi, { runs, titleFor: () => "Review MR" } as never);
	const talk = tools.find((tool) => tool.name === "talk");
	assert.ok(talk?.renderCall);
	assert.ok(talk.renderResult);
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const message = Array.from({ length: 12 }, (_, index) => `审查结论 ${index + 1}`).join("\n");
	const args = { runId: "c3b22f28-abcd", message };
	const call = talk.renderCall(args, theme, { expanded: false }).render(120).map((line) => line.trimEnd()).join("\n");
	assert.match(call, /^› message send · Review MR\n\n审查结论 1/);
	assert.match(call, /审查结论 3/);
	assert.doesNotMatch(call, /审查结论 4/);
	assert.match(call, /\.\.\. \(9 more lines, 12 total, ctrl\+o to expand\)/);
	const expanded = talk.renderCall(args, theme, { expanded: true }).render(120).map((line) => line.trimEnd()).join("\n");
	assert.match(expanded, /审查结论 11\n审查结论 12/);
	const result = talk.renderResult({ details: {} }, { isPartial: false }, theme, { isError: false })
		.render(120).join("\n");
	assert.equal(result.trim(), "");
	const interrupt = tools.find((tool) => tool.name === "interrupt_sub");
	assert.ok(interrupt?.renderCall);
	assert.equal(interrupt.renderCall({ runId: "c3b22f28" }, theme, { expanded: false, state: {} }).render(120).join("\n").trimEnd(), "interrupt · Review MR");
	const close = tools.find((tool) => tool.name === "close_sub");
	assert.ok(close?.renderCall);
	const closeCall = close.renderCall({ runId: "c3b22f28" }, theme, { expanded: false, state: {} })
		.render(120).join("\n").trimEnd();
	assert.equal(closeCall, "close · Review MR");
});

test("interrupt_sub requests cancellation without closing the run", async () => {
	const tools: CapturedTool[] = [];
	const pi = { registerTool: (tool: CapturedTool) => tools.push(tool) } as unknown as ExtensionAPI;
	let interrupted = "";
	registerMainTools(pi, { interrupt: (runId: string) => {
		interrupted = runId;
		return { runId: "c3b22f28-abcd", title: "Review MR" };
	} } as never);
	const result = await tools.find((tool) => tool.name === "interrupt_sub")!.execute!("id", { runId: "c3b22f28" } as never);
	assert.equal(interrupted, "c3b22f28");
	assert.match(result.content[0]!.text, /Requested interruption/);
});

test("list_sub passes the optional all filter and reports live status", async () => {
	const tools: CapturedTool[] = [];
	const pi = { registerTool: (tool: CapturedTool) => tools.push(tool) } as unknown as ExtensionAPI;
	const requested: boolean[] = [];
	registerMainTools(pi, { subs: async (all: boolean) => {
		requested.push(all);
		return { open: [{ run: {
			runId: "c3b22f28-abcd", title: "Review MR", profileName: "reviewer",
			sessionPersistence: "ephemeral", createdAt: Date.now(), surface: { adapter: "herdr" },
		}, status: "blocked" }], resumable: [] };
	} } as never);
	const list = tools.find((tool) => tool.name === "list_sub");
	assert.ok(list?.execute);
	const result = await list.execute("id", {});
	assert.match(result.content[0]!.text, /- blocked c3b22f28 Review MR <reviewer, ephemeral>/);
	await list.execute("id", { all: true });
	assert.deepEqual(requested, [false, true]);
});

test("renders open and resumable Sub sessions under subs", () => {
	const tools: CapturedTool[] = [];
	const pi = { registerTool: (tool: CapturedTool) => tools.push(tool) } as unknown as ExtensionAPI;
	registerMainTools(pi, { runs: new Map() } as never);
	const list = tools.find((tool) => tool.name === "list_sub");
	assert.ok(list?.renderCall);
	assert.ok(list.renderResult);
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	assert.equal(list.renderCall({}, theme, { expanded: false }).render(120).join("\n").trimEnd(), "subs");
	const rendered = list.renderResult({
		details: {
			open: [{
				runId: "c3b22f28-abcd",
				subSessionId: "session-open",
				title: "发布舆情 web 与 job",
				profile: "misc",
				sessionPersistence: "persistent",
				status: "working",
				adapter: "herdr",
				elapsedSeconds: 2788,
			}],
			resumable: [{
				sessionId: "session-closed",
				title: "历史审查",
				cwd: "/tmp/project",
				modifiedSecondsAgo: 7200,
			}],
		},
	}, { isPartial: false }, theme).render(120).join("\n");
	assert.match(rendered, /• 发布舆情 web 与 job/);
	assert.match(rendered, /c3b22f28 · session- · misc · persistent · working · herdr · 46m/);
	assert.match(rendered, /○ 历史审查/);
	assert.match(rendered, /session- · persistent · closed · resumable · project · 2h/);
	assert.doesNotMatch(rendered, /\[failed\]|<misc>|2788s/);
});
