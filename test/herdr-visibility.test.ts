import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../herdr-plugin/index.mjs", import.meta.url));

function runAction(action: string, socketPath: string, stateDir: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [script, action], {
			env: {
				...process.env,
				HERDR_SOCKET_PATH: socketPath,
				HERDR_PLUGIN_ID: "facets.agent-visibility",
				HERDR_PLUGIN_STATE_DIR: stateDir,
			},
			stdio: ["ignore", "ignore", "pipe"],
		});
		let error = "";
		child.stderr.on("data", (chunk) => { error += chunk.toString(); });
		child.on("error", reject);
		child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(error || `action exited ${code}`)));
	});
}

test("Herdr companion action hides and toggles Facets subs", { skip: process.platform === "win32" }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-facets-herdr-view-"));
	const socketPath = path.join(root, "herdr.sock");
	const stateDir = path.join(root, "state");
	const requests: Array<Record<string, unknown>> = [];
	const server = net.createServer((socket) => {
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			const request = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
			requests.push(request);
			socket.end(`${JSON.stringify({ id: request.id, result: { type: "agent_view" } })}\n`);
		});
	});
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, resolve);
		});
		await runAction("hide", socketPath, stateDir);
		await runAction("toggle", socketPath, stateDir);
		assert.equal(requests[0]?.method, "agent.view.set");
		assert.deepEqual((requests[0]?.params as { filter: unknown }).filter, {
			op: "not",
			filter: { op: "eq", field: { token: "facets_role" }, value: "sub" },
		});
		assert.equal(requests[1]?.method, "agent.view.clear");
		assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, "visibility.json"), "utf8")).showSubs, true);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		fs.rmSync(root, { recursive: true, force: true });
	}
});
