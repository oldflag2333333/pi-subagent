import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { publishRelease, readReleasePackage, shouldRelease, type ReleasePackage } from "../.github/scripts/release.js";

const sha = "a".repeat(40);
const pkg: ReleasePackage = { name: "pi-facets", version: "0.6.0", tag: "v0.6.0", prerelease: false, distTag: "latest" };
const options = { repository: "oldflag2333333/pi-facets", sha, token: "fixture-token" };

test("only an increasing package version triggers a release", () => {
	assert.equal(shouldRelease(pkg, undefined), false);
	assert.equal(shouldRelease(pkg, "0.6.0"), false);
	assert.equal(shouldRelease(pkg, "0.5.0"), true);
	assert.equal(shouldRelease(pkg, "0.6.0-rc.1"), true);
	assert.throws(() => shouldRelease(pkg, "0.7.0"), /must increase/);
	assert.throws(() => shouldRelease(pkg, "invalid"), /must increase/);
});

test("release metadata validates the lockfile and distinguishes prereleases", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "facets-release-test-"));
	const write = (version: string, lockVersion = version) => {
		fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "pi-facets", version }));
		fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ name: "pi-facets", version: lockVersion, packages: { "": { name: "pi-facets", version: lockVersion } } }));
	};
	try {
		write("0.6.0");
		assert.deepEqual(readReleasePackage(root), pkg);
		write("0.6.0-rc.1");
		assert.equal(readReleasePackage(root).distTag, "next");
		assert.equal(readReleasePackage(root).prerelease, true);
		write("0.6.0", "0.5.0");
		assert.throws(() => readReleasePackage(root), /matching names and versions/);
		write("0.6.0\ninjected=true");
		assert.throws(() => readReleasePackage(root), /canonical semver/);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function fixture(current = pkg) {
	const state = {
		tagSha: undefined as string | undefined,
		annotated: false,
		published: undefined as { dist: { integrity: string }; gitHead?: string } | undefined,
		distVersion: "0.5.0",
		release: undefined as { id: number; draft: boolean } | undefined,
		registryError: 0,
		releaseError: false,
		publishError: false,
	};
	const events: string[] = [];
	const commands: string[][] = [];
	const writes: Array<{ endpoint: string; body: any }> = [];
	const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
	const fetcher: typeof fetch = async (input, init) => {
		const url = new URL(String(input));
		if (url.hostname === "registry.npmjs.org") {
			if (state.registryError) return response({}, state.registryError);
			if (url.pathname.endsWith(`/${current.version}`)) return state.published ? response(state.published) : response({}, 404);
			assert.ok(url.pathname.endsWith(`/${current.distTag}`));
			return response({ version: state.distVersion });
		}
		assert.equal(url.hostname, "api.github.com");
		assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer fixture-token");
		const endpoint = url.pathname.slice(`/repos/${options.repository}/`.length);
		if (init?.method === "POST" || init?.method === "PATCH") {
			const body = JSON.parse(init.body as string);
			writes.push({ endpoint, body });
			events.push(endpoint);
			if (endpoint === "git/refs") state.tagSha = body.sha;
			if (endpoint === "releases") {
				if (state.releaseError) return response({}, 500);
				state.release = { id: 1, draft: false };
			}
			if (endpoint === "releases/1") state.release = { id: 1, draft: false };
			return response({});
		}
		if (endpoint.startsWith("git/ref/tags/")) return state.tagSha
			? response({ object: { type: state.annotated ? "tag" : "commit", sha: state.tagSha } }) : response({}, 404);
		if (endpoint.startsWith("git/tags/")) return response({ object: { type: "commit", sha: state.tagSha } });
		if (endpoint.startsWith("releases/tags/")) return state.release ? response(state.release) : response({}, 404);
		throw new Error(`Unexpected endpoint ${endpoint}`);
	};
	const run = (command: string, args: string[]) => {
		assert.equal(command, "npm");
		commands.push(args);
		if (args[0] === "pack") return JSON.stringify([{ filename: "package.tgz", integrity: "sha512-fixture" }]);
		assert.equal(args[0], "publish");
		events.push("publish");
		if (state.publishError) throw new Error("Publish failed");
		state.published = { dist: { integrity: "sha512-fixture" }, gitHead: sha };
		return "Published";
	};
	return { state, events, commands, writes, publish: () => publishRelease(current, options, { fetch: fetcher, run }) };
}

test("release binds the version tag to the checked commit, publishes, then generates GitHub notes", async () => {
	const f = fixture();
	await f.publish();
	assert.deepEqual(f.events, ["git/refs", "publish", "releases"]);
	assert.deepEqual(f.writes[0]!.body, { ref: "refs/tags/v0.6.0", sha });
	const command = f.commands.find((args) => args[0] === "publish")!;
	assert.ok(command.includes("--provenance"));
	assert.ok(command.includes("--ignore-scripts"));
	assert.equal(command.at(-1), "latest");
	assert.equal(f.writes[1]!.body.generate_release_notes, true);
	assert.equal(f.writes[1]!.body.target_commitish, sha);
});

test("rerunning after a GitHub failure skips the already-published identical artifact", async () => {
	const f = fixture();
	f.state.releaseError = true;
	await assert.rejects(f.publish(), /HTTP 500/);
	f.state.releaseError = false;
	await f.publish();
	await f.publish();
	assert.equal(f.commands.filter((args) => args[0] === "publish").length, 1);
	assert.equal(f.writes.filter((entry) => entry.endpoint === "git/refs").length, 1);
	assert.equal(f.writes.filter((entry) => entry.endpoint === "releases").length, 2);
});

test("npm failure does not announce a GitHub Release and can retry the reserved tag", async () => {
	const f = fixture();
	f.state.publishError = true;
	await assert.rejects(f.publish(), /Publish failed/);
	assert.deepEqual(f.events, ["git/refs", "publish"]);
	f.state.publishError = false;
	await f.publish();
	assert.equal(f.state.release?.draft, false);
});

test("existing version tags and artifacts are never silently overwritten", async () => {
	const tag = fixture();
	tag.state.tagSha = "b".repeat(40);
	await assert.rejects(tag.publish(), /another commit/);
	assert.deepEqual(tag.commands, []);
	for (const published of [
		{ dist: { integrity: "sha512-different" } },
		{ dist: { integrity: "sha512-fixture" }, gitHead: "b".repeat(40) },
	]) {
		const f = fixture();
		f.state.published = published;
		await assert.rejects(f.publish(), /different contents or source/);
		assert.deepEqual(f.events, []);
	}
});

test("registry outages are not mistaken for an unpublished package and dist-tags never roll back", async () => {
	const f = fixture();
	f.state.registryError = 503;
	await assert.rejects(f.publish(), /HTTP 503/);
	assert.deepEqual(f.events, []);
	f.state.registryError = 0;
	f.state.distVersion = "0.7.0";
	await assert.rejects(f.publish(), /backwards/);
	assert.deepEqual(f.events, []);
});

test("prereleases publish under next without becoming the latest GitHub Release", async () => {
	const f = fixture({ ...pkg, version: "0.6.0-rc.1", tag: "v0.6.0-rc.1", prerelease: true, distTag: "next" });
	await f.publish();
	assert.equal(f.commands.find((args) => args[0] === "publish")!.at(-1), "next");
	assert.equal(f.writes.at(-1)!.body.prerelease, true);
	assert.equal(f.writes.at(-1)!.body.make_latest, "false");
});

test("finishing an older published version does not replace the latest GitHub Release", async () => {
	const f = fixture();
	f.state.tagSha = sha;
	f.state.published = { dist: { integrity: "sha512-fixture" }, gitHead: sha };
	f.state.distVersion = "0.7.0";
	await f.publish();
	assert.equal(f.commands.some((args) => args[0] === "publish"), false);
	assert.equal(f.writes.at(-1)!.body.make_latest, "false");
});

test("a matching annotated tag and an existing draft can be completed", async () => {
	const f = fixture();
	f.state.tagSha = sha;
	f.state.annotated = true;
	f.state.release = { id: 1, draft: true };
	await f.publish();
	assert.deepEqual(f.events, ["publish", "releases/1"]);
});
