import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { selectResumableSubSessions } from "../src/sessions.js";

function session(id: string, name: string | undefined, modified: number): SessionInfo {
	return {
		id,
		path: `/tmp/${id}.jsonl`,
		cwd: "/tmp/project",
		...(name ? { name } : {}),
		created: new Date(0),
		modified: new Date(modified),
		messageCount: 1,
		firstMessage: "task",
		allMessagesText: "task",
	};
}

test("selects closed Facets Sub sessions and excludes current open sessions", () => {
	const selected = selectResumableSubSessions([
		session("open", "[sub] Active review", 10),
		session("closed", "[sub] Previous review", 20),
		session("main", "Ordinary session", 30),
		session("manual", "[sub:manual] review", 40),
	], new Set(["open"]));
	assert.deepEqual(selected, [{
		sessionId: "closed",
		sessionFile: "/tmp/closed.jsonl",
		title: "Previous review",
		cwd: "/tmp/project",
		modifiedAt: 20,
	}]);
});
