// Offline stdio MCP server for exercising Pi's real connection lifecycle.
import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
	const request = JSON.parse(line);
	if (request.id === undefined) return;
	let result;
	switch (request.method) {
		case "initialize":
			result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: "facets-test", version: "1.0.0" } };
			break;
		case "tools/list":
			result = { tools: ["echo", "direct", "hidden"].map((name) => ({ name, description: `Fixture ${name}`, inputSchema: { type: "object", properties: {} } })) };
			break;
		case "tools/call":
			result = { content: [{ type: "text", text: `MCP fixture: ${request.params.name}` }] };
			break;
		case "resources/list":
			result = { resources: [{ uri: "fixture://text", name: "Fixture text", mimeType: "text/plain" }] };
			break;
		case "resources/templates/list":
			result = { resourceTemplates: [] };
			break;
		case "resources/read":
			result = { contents: [{ uri: request.params.uri, text: "Fixture resource", mimeType: "text/plain" }] };
			break;
		default:
			result = {};
	}
	// Delay the handshake so the Sub must become ready before MCP tools exist.
	setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n"), request.method === "initialize" ? 50 : 0);
});
