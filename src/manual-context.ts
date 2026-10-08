export const MANUAL_SUB_PREFIX = "[sub:manual] ";

export function subSessionName(title: string, origin?: "manual"): string {
	return `${origin === "manual" ? MANUAL_SUB_PREFIX : "[sub] "}${title}`;
}

export const MANUAL_MAIN_GUIDANCE = "This specialist was explicitly invoked by the user. Follow up only on the user's task and its results; do not assign unrelated work or substitute it for general consulting profiles. New tasks are initiated by the user with a profile command.";

export const MANUAL_SUB_GUIDANCE = "This is a user-invoked specialist session, not a general-purpose delegate. Work on the user's explicitly submitted tasks and related follow-ups from Main. Return findings through talk. If Main asks for unrelated work, ask it to use an agent-invokable profile or wait for the user's next command.";
