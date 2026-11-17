import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResolvedProfile } from "./types.js";

/** Talk uses Pi's user-input path, so idle deliveries share normal prompt assembly. */
export function bindPromptSections(pi: ExtensionAPI, keys: readonly string[], getSections: () => Record<string, string>): void {
	pi.on("before_agent_start", (event) => {
		const sections = getSections();
		for (const key of keys) {
			if (sections[key]) event.systemPromptOptions.sections[key] = sections[key]!;
			else delete event.systemPromptOptions.sections[key];
		}
	});
}

export const SUB_PROTOCOL = `## Pi Subagent Sub protocol
You are an isolated Sub Pi working with a Main Pi. You have not received the Main's conversation and must not read Pi session files.
Work quietly by default. Use talk to deliver completed work, raise a blocker or question that requires Main's input, report a material change that affects Main's decisions or coordination, or answer an explicit status request. Do not send routine acknowledgements, startup or preflight notices, step-by-step progress, or unchanged polling status. Combine related findings into one concise message with the necessary evidence and next action. When handling follow-ups, use the latest instructions already available to you; do not repeat an unchanged result just to acknowledge an older message.
Make clear whether Main needs to act and whether you are continuing, blocked, or finished. By default, talk only sends the message. After a necessary progress update, continue the assigned task without waiting for Main to acknowledge or say 'continue'.
Set endTurn=true only when the task is complete or you must wait for Main's reply before proceeding. Call terminating talk on its own, without other tools in the same batch. Ending a turn does not close the session; remain available for follow-ups. The Main alone decides whether to respond, request more work, or close this Sub session. Never close the session yourself.`;

export function applySubPromptSections(sections: Record<string, string>, profile: ResolvedProfile): void {
	sections.subagent_sub_protocol = SUB_PROTOCOL;
	if (profile.instructions) sections.subagent_profile = `## Pi Subagent profile: ${profile.name}\n${profile.instructions}`;
	else delete sections.subagent_profile;
}

export function applyStartupPromptSections(
	sections: Record<string, string>,
	profile: ResolvedProfile | undefined,
	profilesContext: string,
): void {
	if (profilesContext) sections.subagent_profiles = profilesContext;
	else delete sections.subagent_profiles;
	if (profile?.instructions) sections.subagent_profile = `## Active Pi Subagent profile: ${profile.name}\n${profile.instructions}`;
	else delete sections.subagent_profile;
}
