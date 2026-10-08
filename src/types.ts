import type { ResolvedProfile, SessionPersistence } from "./profiles/types.js";

export interface DelegateManifest {
	version: 1;
	runId: string;
	mainSessionId: string;
	title: string;
	task: string;
	cwd: string;
	profile: ResolvedProfile;
	origin?: "manual";
	token: string;
	createdAt: number;
}

export interface TalkMessage {
	version: 1;
	id: string;
	sequence: number;
	runId: string;
	token: string;
	createdAt: number;
	message: string;
}

export interface SubSessionInfo {
	version: 1;
	runId: string;
	token: string;
	sessionId: string;
	sessionFile: string;
	createdAt: number;
}

export interface ActiveTurn {
	version: 1;
	runId: string;
	token: string;
	turnId: string;
	createdAt: number;
}

export interface InterruptRequest extends ActiveTurn {
	requestedAt: number;
}

export interface CloseMessage {
	version: 1;
	runId: string;
	token: string;
	createdAt: number;
	reason: string;
}

export interface SubClosedMessage {
	version: 1;
	runId: string;
	token: string;
	createdAt: number;
	reason: string;
}

export type SubAgentStatus = "working" | "blocked" | "idle" | "unknown";

export interface SurfaceHandle {
	adapter: "herdr";
	tabId?: string;
	paneId?: string;
}

export interface RunSnapshot {
	version: 1;
	runId: string;
	mainSessionId: string;
	title: string;
	cwd: string;
	profileName: string;
	origin?: "manual";
	purpose?: string;
	sessionPersistence: SessionPersistence;
	channelDir: string;
	createdAt: number;
	updatedAt: number;
	/** Surface is closed; retain the channel only until pending messages are received. */
	closedAt?: number;
	subSessionId?: string;
	subSessionFile?: string;
	surface?: SurfaceHandle;
}

export interface SubLaunchSpec {
	runId: string;
	mainSessionId: string;
	title: string;
	task: string;
	cwd: string;
	projectTrusted: boolean;
	origin?: "manual";
	resumeSessionId?: string;
	profile: ResolvedProfile;
	channelDir: string;
	token: string;
	entryPath: string;
}

export interface SubSurfaceAdapter {
	readonly id: "herdr";
	available(): Promise<boolean>;
	launch(spec: SubLaunchSpec, signal?: AbortSignal): Promise<SurfaceHandle>;
	close(handle: SurfaceHandle): Promise<void>;
}
