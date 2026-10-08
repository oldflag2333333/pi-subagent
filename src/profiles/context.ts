import type { ProfileCatalog } from "./types.js";

const MAX_CONTEXT_BYTES = 16 * 1024;

export function buildProfilesContext(catalog: ProfileCatalog): string {
	const header = "## Available Facets delegation profiles\n";
	const footer = "Use the exact profile name as delegate.profile. Project profiles override same-named global profiles.";
	const profiles = [...catalog.profiles.values()].filter((profile) => profile.invocation !== "manual").sort((left, right) => left.name.localeCompare(right.name));
	if (profiles.length === 0) {
		return `${header}No agent-invokable profiles are configured. Do not call delegate until the user configures one.\n${footer}`;
	}

	const lines: string[] = [];
	let omitted = 0;
	for (const profile of profiles) {
		const persistence = profile.sessionPersistence ?? "ephemeral";
		const line = `- ${profile.name} [${profile.source}, ${persistence}]${profile.description ? `: ${profile.description}` : ""}`;
		const candidate = `${header}${[...lines, line].join("\n")}\n${footer}`;
		if (Buffer.byteLength(candidate, "utf8") > MAX_CONTEXT_BYTES) {
			omitted += 1;
			continue;
		}
		lines.push(line);
	}
	if (omitted > 0) lines.push(`- (${omitted} additional profiles omitted from context)`);
	return `${header}${lines.join("\n")}\n${footer}`;
}
