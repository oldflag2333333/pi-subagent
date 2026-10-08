import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const pluginId = process.env.HERDR_PLUGIN_ID ?? "facets.agent-visibility";
const source = `plugin:${pluginId}`;
const socketPath = process.env.HERDR_SOCKET_PATH;
const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;

function statePath() {
	if (!stateDir) throw new Error("HERDR_PLUGIN_STATE_DIR is missing.");
	return path.join(stateDir, "visibility.json");
}

function readState() {
	try {
		const value = JSON.parse(fs.readFileSync(statePath(), "utf8"));
		return { showSubs: value?.showSubs === true };
	} catch (error) {
		if (error?.code === "ENOENT") return { showSubs: false };
		throw error;
	}
}

function writeState(state) {
	const file = statePath();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(temporary, file);
}

function send(method, params) {
	if (!socketPath) return Promise.reject(new Error("HERDR_SOCKET_PATH is missing."));
	const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
	const request = { id: `facets:${Date.now()}:${process.pid}`, method, params };
	return new Promise((resolve, reject) => {
		let buffer = "";
		const socket = net.createConnection(endpoint);
		const timeout = setTimeout(() => {
			socket.destroy();
			reject(new Error("Timed out waiting for Herdr."));
		}, 5000);
		const finish = (callback) => {
			clearTimeout(timeout);
			socket.destroy();
			callback();
		};
		socket.on("error", (error) => finish(() => reject(error)));
		socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			try {
				const response = JSON.parse(buffer.slice(0, newline));
				if (response.error) throw new Error(response.error.message ?? JSON.stringify(response.error));
				finish(() => resolve(response.result));
			} catch (error) {
				finish(() => reject(error));
			}
		});
	});
}

async function apply(showSubs) {
	if (showSubs) {
		await send("agent.view.clear", { source });
		return;
	}
	await send("agent.view.set", {
		source,
		label: "subs hidden",
		filter: {
			op: "not",
			filter: {
				op: "eq",
				field: { token: "facets_role" },
				value: "sub",
			},
		},
		sort: [],
	});
}

export async function run(action = "startup") {
	const current = readState();
	const next = action === "toggle"
		? { showSubs: !current.showSubs }
		: action === "show"
			? { showSubs: true }
			: action === "hide" || action === "startup"
				? current
				: undefined;
	if (!next) throw new Error(`Unknown action '${action}'.`);
	if (action === "hide") next.showSubs = false;
	writeState(next);
	await apply(next.showSubs);
	console.log(next.showSubs ? "Facets subs are visible." : "Facets subs are hidden.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	run(process.argv[2] ?? "startup").catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
