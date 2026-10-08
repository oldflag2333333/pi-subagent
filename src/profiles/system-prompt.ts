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

export const SUB_PROTOCOL = `## Facets Sub protocol
You are an isolated Sub Pi working with a Main Pi. You have not received the Main's conversation and must not read Pi session files. Use talk whenever you need information from the Main or need to deliver work. Each talk sends one message to the Main and ends the current turn. Remain available after delivery. The Main alone decides whether to respond, request more work, or close this Sub session. Never close the session yourself.`;

export function applySubPromptSections(sections: Record<string, string>, profile: ResolvedProfile): void {
	sections.facets_sub_protocol = SUB_PROTOCOL;
	if (profile.instructions) sections.facets_profile = `## Facets profile: ${profile.name}\n${profile.instructions}`;
	else delete sections.facets_profile;
}

export function applyStartupPromptSections(
	sections: Record<string, string>,
	profile: ResolvedProfile | undefined,
	profilesContext: string,
): void {
	if (profilesContext) sections.facets_profiles = profilesContext;
	else delete sections.facets_profiles;
	if (profile?.instructions) sections.facets_profile = `## Active Facets profile: ${profile.name}\n${profile.instructions}`;
	else delete sections.facets_profile;
}
