import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import semver from "semver";

export interface ReleasePackage {
	name: string;
	version: string;
	tag: string;
	prerelease: boolean;
	distTag: "latest" | "next";
}

export function readReleasePackage(directory: string): ReleasePackage {
	const pkg = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
	const lock = JSON.parse(fs.readFileSync(path.join(directory, "package-lock.json"), "utf8"));
	if (typeof pkg.name !== "string" || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(pkg.name) || pkg.private) {
		throw new Error("Expected a public npm package with a valid name.");
	}
	if (typeof pkg.version !== "string" || semver.valid(pkg.version) !== pkg.version) throw new Error("Expected a canonical semver package version.");
	if (lock.name !== pkg.name || lock.version !== pkg.version || lock.packages?.[""]?.version !== pkg.version || lock.packages?.[""]?.name !== pkg.name) {
		throw new Error("package.json and package-lock.json must have matching names and versions.");
	}
	const prerelease = semver.prerelease(pkg.version) !== null;
	return { name: pkg.name, version: pkg.version, tag: `v${pkg.version}`, prerelease, distTag: prerelease ? "next" : "latest" };
}

export function shouldRelease(current: ReleasePackage, previousVersion: string | undefined): boolean {
	// Creating the main branch or installing this workflow does not publish an existing version.
	if (previousVersion === undefined || previousVersion === current.version) return false;
	if (!semver.valid(previousVersion) || !semver.gt(current.version, previousVersion)) {
		throw new Error(`Release versions must increase: ${previousVersion} -> ${current.version}.`);
	}
	return true;
}

type Run = (command: string, args: string[]) => string;
interface ReleaseOptions {
	repository: string;
	sha: string;
	token: string;
}
interface Dependencies {
	fetch: typeof fetch;
	run: Run;
}

/** Publish the checked artifact and create its Release in this same job, not via a second trigger. */
export async function publishRelease(pkg: ReleasePackage, options: ReleaseOptions, deps: Dependencies): Promise<void> {
	if (!/^[\w.-]+\/[\w.-]+$/.test(options.repository) || !/^[a-f0-9]{40}$/.test(options.sha) || !options.token) {
		throw new Error("Missing or invalid GitHub release identity.");
	}
	const api = async (endpoint: string, method = "GET", body?: unknown, allowMissing = false): Promise<any> => {
		const response = await deps.fetch(`https://api.github.com/repos/${options.repository}/${endpoint}`, {
			method,
			headers: { Authorization: `Bearer ${options.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		if (allowMissing && response.status === 404) return undefined;
		if (!response.ok) throw new Error(`GitHub ${method} ${endpoint} failed: HTTP ${response.status}.`);
		return response.json();
	};
	const registry = async (version: string): Promise<any> => {
		const response = await deps.fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${encodeURIComponent(version)}`);
		if (response.status === 404) return undefined;
		if (!response.ok) throw new Error(`npm registry lookup failed: HTTP ${response.status}.`);
		return response.json();
	};
	const ref = await api(`git/ref/tags/${pkg.tag}`, "GET", undefined, true);
	if (ref) {
		let object = ref.object;
		for (let depth = 0; object?.type === "tag" && depth < 5; depth++) object = (await api(`git/tags/${object.sha}`)).object;
		if (object?.type !== "commit" || object.sha !== options.sha) throw new Error(`Tag ${pkg.tag} already points at another commit; refusing to move it.`);
	}

	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "facets-release-"));
	try {
		const [packed] = JSON.parse(deps.run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary]));
		if (!packed || typeof packed.filename !== "string" || path.basename(packed.filename) !== packed.filename || typeof packed.integrity !== "string") {
			throw new Error("npm pack returned no valid artifact.");
		}
		const existing = await registry(pkg.version);
		if (existing && (existing.dist?.integrity !== packed.integrity || (existing.gitHead && existing.gitHead !== options.sha))) {
			throw new Error(`${pkg.name}@${pkg.version} is already published with different contents or source; bump the version.`);
		}
		const currentTag = await registry(pkg.distTag);
		if (currentTag?.version && !semver.valid(currentTag.version)) throw new Error("npm returned an invalid dist-tag version.");
		if (!existing && currentTag?.version && semver.gte(currentTag.version, pkg.version)) {
			throw new Error(`Refusing to move npm ${pkg.distTag} backwards from ${currentTag.version} to ${pkg.version}.`);
		}
		// A late retry can finish an older Release without replacing the latest one.
		const makeLatest = !pkg.prerelease && (!currentTag?.version || semver.gte(pkg.version, currentTag.version)) ? "true" : "false";
		// Reserve the exact source commit before publishing. A failed publish can be
		// retried on this commit; no job may silently repoint the version tag.
		if (!ref) await api("git/refs", "POST", { ref: `refs/tags/${pkg.tag}`, sha: options.sha });
		if (!existing) {
			deps.run("npm", ["publish", path.join(temporary, packed.filename), "--access", "public", "--provenance", "--ignore-scripts", "--tag", pkg.distTag]);
			console.log(`Published ${pkg.name}@${pkg.version} to npm (${pkg.distTag}).`);
		} else {
			console.log(`${pkg.name}@${pkg.version} already has the same artifact; finishing GitHub Release only.`);
		}
		const release = await api(`releases/tags/${pkg.tag}`, "GET", undefined, true);
		if (!release) {
			await api("releases", "POST", {
				tag_name: pkg.tag, target_commitish: options.sha, name: pkg.tag,
				generate_release_notes: true, prerelease: pkg.prerelease,
				make_latest: makeLatest,
			});
		} else if (release.draft) {
			await api(`releases/${release.id}`, "PATCH", { draft: false, prerelease: pkg.prerelease, make_latest: makeLatest });
		}
	} finally {
		fs.rmSync(temporary, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	const directory = process.cwd();
	const pkg = readReleasePackage(directory);
	const run: Run = (command, args) => execFileSync(command, args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
	if (process.argv[2] === "validate") {
		console.log(`Valid package metadata: ${pkg.name}@${pkg.version}`);
		return;
	}
	if (process.argv[2] === "plan") {
		const before = process.env.BEFORE_SHA;
		if (!before || !/^[a-f0-9]{40}$/.test(before)) throw new Error("BEFORE_SHA must be the push event's previous commit.");
		const previous = /^0+$/.test(before) ? undefined : JSON.parse(run("git", ["show", `${before}:package.json`])).version;
		const release = shouldRelease(pkg, previous);
		const output = process.env.GITHUB_OUTPUT;
		if (!output) throw new Error("GITHUB_OUTPUT is missing.");
		fs.appendFileSync(output, `release=${release}\nversion=${pkg.version}\n`);
		console.log(release ? `Release ${pkg.tag} after checks pass.` : "Package version is unchanged; no release.");
		return;
	}
	if (process.argv[2] !== "publish" || process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_EVENT_NAME !== "push" || process.env.GITHUB_REF !== "refs/heads/main") {
		throw new Error("Publishing is only supported by the main push workflow.");
	}
	const repository = process.env.GITHUB_REPOSITORY ?? "";
	const sha = process.env.GITHUB_SHA ?? "";
	if (pkg.version !== process.env.RELEASE_VERSION || run("git", ["rev-parse", "HEAD"]).trim() !== sha) throw new Error("Release plan and checked-out source do not match.");
	const metadata = JSON.parse(fs.readFileSync("package.json", "utf8"));
	if (metadata.repository?.url !== `git+https://github.com/${repository}.git`) throw new Error("package.json repository.url must match the trusted GitHub repository.");
	await publishRelease(pkg, { repository, sha, token: process.env.GH_TOKEN ?? "" }, { fetch, run });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
