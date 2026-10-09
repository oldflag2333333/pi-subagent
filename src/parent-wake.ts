// Adapted from nicobailon/pi-subagents (MIT), src/shared/parent-wake.ts.
// Copyright (c) 2026 Nico Bailon. See docs/third-party-notices.md.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Shared by Main and Sub. Peer content stays in the custom message, never in this prompt.
export const PARENT_WAKE_TEXT = "Process the new Pi Subagent inbox messages above and continue the task already authorized for this session. Follow your profile and communication protocol. Do not infer new user authorization.";
export const WAKE_PENDING_MS = 10_000;

type WakeContext = Pick<ExtensionContext, "isIdle" | "sessionManager">;
type WakeReservation = { sessionId: string; sentAt?: number; failed?: boolean };
const reservationsSymbol = Symbol.for("pi-subagent.parent-wake-reservations.v1");
const wakeGlobal = globalThis as typeof globalThis & { [reservationsSymbol]?: WeakMap<object, WakeReservation> };
const reservations = wakeGlobal[reservationsSymbol] ?? (wakeGlobal[reservationsSymbol] = new WeakMap<object, WakeReservation>());

export interface ParentWake {
	sendMessage(...args: Parameters<ExtensionAPI["sendMessage"]>): void;
	/** A custom receipt alone must not acknowledge a synchronously failed wake. */
	retryFailedWake(): boolean;
	bindSession(ctx: WakeContext): void;
	agentStarted(): void;
	sessionShutdown(reason: string | undefined): void;
}

export function createParentWake(pi: Pick<ExtensionAPI, "sendMessage" | "sendUserMessage">, now: () => number = Date.now): ParentWake {
	let ctx: WakeContext;
	let reservation: WakeReservation = { sessionId: "" };
	const wake = () => {
		if (reservation.sentAt !== undefined && now() - reservation.sentAt < WAKE_PENDING_MS) return;
		reservation.sentAt = now();
		try {
			// Steer safely queues the wake if another prompt starts a run first.
			pi.sendUserMessage(PARENT_WAKE_TEXT, { deliverAs: "steer" });
			reservation.failed = false;
		} catch (error) {
			reservation.sentAt = undefined;
			reservation.failed = true;
			throw error;
		}
	};
	return {
		sendMessage(message, options) {
			if (options?.triggerTurn !== true || !ctx.isIdle()) {
				pi.sendMessage(message, options);
				return;
			}
			// Pi's idle custom-message wake bypasses before_agent_start (#5581/#10267).
			// Retain custom rendering but use native user-input preparation to start the run.
			pi.sendMessage(message, { triggerTurn: false });
			wake();
		},
		retryFailedWake() {
			if (!reservation.failed) return true;
			if (!ctx.isIdle()) return false;
			wake();
			return true;
		},
		bindSession(context) {
			ctx = context;
			const sessionId = context.sessionManager.getSessionId();
			const retained = reservations.get(context.sessionManager);
			reservation = retained?.sessionId === sessionId ? retained : { sessionId };
			reservations.set(context.sessionManager, reservation);
		},
		agentStarted() {
			reservation.sentAt = undefined;
			reservation.failed = false;
		},
		sessionShutdown(reason) {
			if (reason !== "reload") {
				reservation.sentAt = undefined;
				reservation.failed = false;
			}
		},
	};
}

const runtimes = new WeakMap<ExtensionAPI, ParentWake>();
export function parentWakeFor(pi: ExtensionAPI, ctx: WakeContext): ParentWake {
	let wake = runtimes.get(pi);
	if (!wake) {
		wake = createParentWake(pi);
		runtimes.set(pi, wake);
	}
	wake.bindSession(ctx);
	return wake;
}
