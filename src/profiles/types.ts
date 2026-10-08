export type ProfileSource = "global" | "project";
export type SessionPersistence = "ephemeral" | "persistent";
export type ProfileInvocation = "both" | "manual";

export interface ProfileDefinition {
	version: 1;
	name: string;
	description?: string;
	model?: string;
	thinkingLevel?: string;
	sessionPersistence?: SessionPersistence;
	/** Manual profiles are started by user commands, not model delegation. */
	invocation?: ProfileInvocation;
	tools: string[];
	skills?: string[];
	instructions?: string;
}

export interface LoadedProfile extends ProfileDefinition {
	source: ProfileSource;
	sourcePath: string;
}

export interface ResolvedProfile extends LoadedProfile {
	resolvedSkills: string[];
	resolvedExtensions: string[];
}

export interface ProfileDiagnostic {
	path: string;
	message: string;
}

export interface ProfileCatalog {
	profiles: Map<string, LoadedProfile>;
	diagnostics: ProfileDiagnostic[];
}
