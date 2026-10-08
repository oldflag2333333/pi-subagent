import * as fs from "node:fs";
import * as path from "node:path";
import type { TalkDirection } from "./channel.js";

export const CHANNEL_DEBOUNCE_MS = 20;
export const CHANNEL_RESCAN_MS = 5000;
export type WatchDirectory = (directory: string, listener: (event: fs.WatchEventType, filename: string | Buffer | null) => void) => fs.FSWatcher;
interface WatchedDirectory {
	path: string;
	accept: (name: string) => boolean;
	watcher?: fs.FSWatcher;
	error?: string;
}
interface WatchedChannel {
	directory: string;
	direction: TalkDirection;
	directories: WatchedDirectory[];
}

/** Files notify; the same bounded rescan path handles missed/unsupported watches. */
export class ChannelMonitor {
	private readonly channels = new Map<string, WatchedChannel>();
	private readonly dirty = new Set<string>();
	private active = false;
	private debounce?: ReturnType<typeof setTimeout>;
	private fallback?: ReturnType<typeof setInterval>;

	constructor(
		private readonly scan: (ids: string[]) => void,
		private readonly onError: (id: string, error: unknown) => void,
		private readonly onRecovered: (id: string) => void = () => {},
		private readonly watch: WatchDirectory = (directory, listener) => fs.watch(directory, { persistent: false }, listener),
	) {}

	start(): void {
		if (this.active) return;
		this.active = true;
		for (const [id, channel] of this.channels) this.attach(id, channel);
		this.fallback = setInterval(() => {
			for (const [id, channel] of this.channels) this.attach(id, channel);
			this.wakeAll();
		}, CHANNEL_RESCAN_MS);
		this.fallback.unref?.();
	}

	add(id: string, directory: string, direction: TalkDirection): void {
		const existing = this.channels.get(id);
		if (existing?.directory === directory && existing.direction === direction) return;
		this.remove(id);
		const controls = new Set(direction === "to-main" ? ["session.json", "closed.json"] : ["close.json", "interrupt.json"]);
		const channel: WatchedChannel = {
			directory, direction,
			directories: [
				{ path: directory, accept: (name) => controls.has(name) },
				{ path: path.join(directory, direction), accept: (name) => name.endsWith(".json") },
			],
		};
		this.channels.set(id, channel);
		if (this.active) this.attach(id, channel);
	}

	private attach(id: string, channel: WatchedChannel): void {
		for (const slot of channel.directories) {
			if (slot.watcher) continue;
			const fail = (error: unknown) => {
				if (!this.active || this.channels.get(id) !== channel) return;
				const signature = error instanceof Error ? error.message : String(error);
				if (slot.error !== signature) { slot.error = signature; this.onError(id, error); }
			};
			try {
				const watcher = this.watch(slot.path, (_event, filename) => {
					if (this.channels.get(id) !== channel) return;
					if (filename == null || slot.accept(path.basename(filename.toString()))) this.wake(id);
				});
				slot.watcher = watcher;
				watcher.on("error", (error) => {
					if (slot.watcher !== watcher) return;
					slot.watcher = undefined;
					watcher.close();
					fail(error);
					this.wake(id);
				});
				watcher.on("close", () => {
					if (slot.watcher !== watcher) return;
					slot.watcher = undefined;
					fail(new Error(`File watcher closed: ${slot.path}`));
				});
				if (slot.error) { slot.error = undefined; this.onRecovered(id); }
			} catch (error) { fail(error); }
		}
	}

	wake(id: string): void {
		if (!this.active || !this.channels.has(id)) return;
		this.dirty.add(id);
		if (this.debounce) return;
		this.debounce = setTimeout(() => {
			this.debounce = undefined;
			const ids = [...this.dirty];
			this.dirty.clear();
			if (!this.active || ids.length === 0) return;
			try { this.scan(ids); } catch (error) { this.onError(ids.join(", "), error); }
		}, CHANNEL_DEBOUNCE_MS);
		this.debounce.unref?.();
	}
	wakeAll(): void {
		for (const id of this.channels.keys()) this.wake(id);
	}
	remove(id: string): void {
		const channel = this.channels.get(id);
		this.channels.delete(id);
		this.dirty.delete(id);
		for (const slot of channel?.directories ?? []) {
			const watcher = slot.watcher;
			slot.watcher = undefined;
			watcher?.close();
		}
	}
	stop(): void {
		this.active = false;
		if (this.debounce) clearTimeout(this.debounce);
		if (this.fallback) clearInterval(this.fallback);
		this.debounce = undefined;
		this.fallback = undefined;
		for (const id of [...this.channels.keys()]) this.remove(id);
	}
}
