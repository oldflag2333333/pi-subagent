# Releasing Facets

Maintainer guide. For installation and usage, see the [README](../README.md).

## CI and automatic npm releases

GitHub Actions runs type checks, tests, package metadata validation, and a packaging dry run for pull requests and pushes to `main` and `dev`, on Node.js 22.19 and 24.

A **version increase in `package.json` pushed to `main`** releases automatically after both check jobs pass:

1. Validate the matching version in `package-lock.json`.
2. Reserve `v<version>` at the exact checked commit.
3. Publish the npm tarball through OIDC trusted publishing, with provenance.
4. Create the GitHub Release with automatically generated release notes.

Ordinary code/dependency changes with no version increase do not publish. Neither PRs, `dev` pushes, tag pushes, nor installing the workflow alone publish a package. Stable versions use npm's `latest` tag; prereleases such as `0.6.0-rc.1` use `next` and GitHub's prerelease flag.

### One-time npm setup

In the npm settings for **pi-facets**, add a **GitHub Actions Trusted Publisher**:

| Setting | Value |
| --- | --- |
| Organization or user | `oldflag2333333` |
| Repository | `pi-facets` |
| Workflow filename | `release.yml` (filename only, not a path) |
| Environment | Leave blank; this workflow does not use a GitHub Environment |
| Allowed actions | Allow direct `npm publish` |

No `NPM_TOKEN` secret is needed. GitHub supplies its built-in `GITHUB_TOKEN` for tags/releases; only the release job has `contents: write` and `id-token: write`. Publishing runs on a GitHub-hosted runner with Node 24 and a pinned npm 11 CLI. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for package-side setup.

Commit the workflow to GitHub and enable Actions before the first version bump. Keep `package.json`'s `repository.url` aligned with this repository; npm provenance and the release script verify that identity.

### Releasing

On your feature/release branch:

```bash
npm version minor --no-git-tag-version
# Or: npm version patch --no-git-tag-version
git add package.json package-lock.json
git commit -m "chore: release v0.6.0"
```

Merge that change into `main` (or push it directly if your branch policy allows). The workflow handles the tag, npm publication, and GitHub Release; do not run `npm publish` yourself.

If publishing fails, correct the external setup and **re-run the original failed workflow** on its original commit. An identical already-published artifact is not republished, so a failed GitHub Release step can be completed safely. An existing tag pointing elsewhere, an npm version with different contents, or a version that would move a dist-tag backwards causes an error instead of an overwrite. A failed npm publish may leave its reserved Git tag, but no GitHub Release is announced until publication succeeds. Publish one version at a time.

GitHub Releases created by `GITHUB_TOKEN` do not trigger a second release workflow, so npm publication and Release creation deliberately run in the same job.

