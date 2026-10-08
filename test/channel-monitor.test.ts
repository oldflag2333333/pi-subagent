import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { ChannelMonitor, CHANNEL_DEBOUNCE_MS, CHANNEL_RESCAN_MS, type WatchDirectory } from "../src/channel-monitor.js";

class FakeWatch extends EventEmitter {
	closed = 0;
	constructor(readonly notify: Parameters<WatchDirectory>[1]) { super(); }
	close() { this.closed++; this.emit("close"); }
}
function watcherFixture() {
	const watchers = new Map<string, FakeWatch>();
	const batches: string[][] = [];
	const errors: string[] = [];
	const recovered: string[] = [];
	let unsupported = false;
	const watch: WatchDirectory = (directory, notify) => {
		if (unsupported) throw new Error(`Unsupported watch: ${directory}`);
		const watcher = new FakeWatch(notify);
		watchers.set(directory, watcher);
		return watcher as unknown as fs.FSWatcher;
	};
	const monitor = new ChannelMonitor((ids) => batches.push(ids), (_id, error) => errors.push(String(error)), (id) => recovered.push(id), watch);
	return { monitor, watchers, batches, errors, recovered, unsupported: (value: boolean) => { unsupported = value; } };
}

test("coalesces dirty channels and ignores temp files and unrelated control writes", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const f = watcherFixture();
	f.monitor.add("a", "/a", "to-main");
	f.monitor.add("b", "/b", "to-sub");
	f.monitor.start();
	try {
		f.watchers.get("/a")!.notify("rename", "to-main-sequence.json");
		f.watchers.get("/a/to-main")!.notify("rename", "message.json.tmp");
		t.mock.timers.tick(CHANNEL_DEBOUNCE_MS);
		assert.deepEqual(f.batches, []);
		f.watchers.get("/a/to-main")!.notify("rename", "message.json");
		f.watchers.get("/a")!.notify("rename", "closed.json");
		f.watchers.get("/b")!.notify("rename", "interrupt.json");
		f.watchers.get("/b/to-sub")!.notify("change", null);
		t.mock.timers.tick(CHANNEL_DEBOUNCE_MS);
		assert.deepEqual(f.batches, [["a", "b"]]);
	} finally { f.monitor.stop(); }
});

test("falls back to a five-second scan when filesystem events are missed", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const f = watcherFixture();
	f.monitor.add("a", "/a", "to-main");
	f.monitor.start();
	try {
		t.mock.timers.tick(CHANNEL_RESCAN_MS - 1);
		assert.deepEqual(f.batches, []);
		t.mock.timers.tick(1);
		t.mock.timers.tick(CHANNEL_DEBOUNCE_MS);
		assert.deepEqual(f.batches, [["a"]]);
	} finally { f.monitor.stop(); }
});

test("unsupported or failed watches do not disable fallback and are reattached", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const f = watcherFixture();
	f.unsupported(true);
	f.monitor.add("a", "/a", "to-main");
	f.monitor.start();
	try {
		assert.equal(f.errors.length, 2);
		t.mock.timers.tick(CHANNEL_RESCAN_MS);
		t.mock.timers.tick(CHANNEL_DEBOUNCE_MS);
		assert.deepEqual(f.batches, [["a"]]);
		assert.equal(f.errors.length, 2);
		f.unsupported(false);
		t.mock.timers.tick(CHANNEL_RESCAN_MS);
		t.mock.timers.tick(CHANNEL_DEBOUNCE_MS);
		assert.equal(f.watchers.size, 2);
		assert.equal(f.recovered.length, 2);
		const lost = f.watchers.get("/a/to-main")!;
		lost.emit("error", new Error("Watch lost"));
		assert.equal(lost.closed, 1);
		t.mock.timers.tick(CHANNEL_DEBOUNCE_MS);
		t.mock.timers.tick(CHANNEL_RESCAN_MS);
		t.mock.timers.tick(CHANNEL_DEBOUNCE_MS);
		assert.notEqual(f.watchers.get("/a/to-main"), lost);
	} finally { f.monitor.stop(); }
});

test("shutdown cancels pending scans and closes all watchers without stale callbacks", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const f = watcherFixture();
	f.monitor.add("a", "/a", "to-main");
	f.monitor.start();
	const old = f.watchers.get("/a/to-main")!;
	old.notify("rename", "message.json");
	f.monitor.stop();
	t.mock.timers.tick(CHANNEL_RESCAN_MS + CHANNEL_DEBOUNCE_MS);
	assert.deepEqual(f.batches, []);
	assert.ok([...f.watchers.values()].every((watcher) => watcher.closed === 1));
	f.monitor.add("a", "/a", "to-main");
	f.monitor.start();
	try {
		old.notify("rename", "late.json");
		t.mock.timers.tick(CHANNEL_DEBOUNCE_MS);
		assert.deepEqual(f.batches, []);
		f.watchers.get("/a/to-main")!.notify("rename", "new.json");
		t.mock.timers.tick(CHANNEL_DEBOUNCE_MS);
		assert.deepEqual(f.batches, [["a"]]);
	} finally { f.monitor.stop(); }
});

test("native filesystem watching observes atomic rename without waiting for fallback", async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "facets-watch-"));
	fs.mkdirSync(path.join(root, "to-main"));
	const batches: string[][] = [];
	const errors: unknown[] = [];
	const monitor = new ChannelMonitor((ids) => batches.push(ids), (_id, error) => errors.push(error));
	monitor.add("run", root, "to-main");
	monitor.start();
	try {
		if (errors.length > 0) { t.skip("Native filesystem watching is unavailable"); return; }
		const temporary = path.join(root, "to-main", "message.json.tmp");
		fs.writeFileSync(temporary, "{}");
		fs.renameSync(temporary, path.join(root, "to-main", "message.json"));
		const deadline = Date.now() + 2000;
		while (batches.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.deepEqual(batches, [["run"]]);
		assert.deepEqual(errors, []);
	} finally { monitor.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});
