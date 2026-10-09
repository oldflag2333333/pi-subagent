# Releasing Pi Subagent

English | [简体中文](releasing.zh-CN.md)

## What CI does

`.github/workflows/release.yml` runs on PRs and pushes to `main`/`dev`, and through **Actions → CI and Release → Run workflow**.

- Type checks and tests on Node **22.19.0** and **24**.
- Package/lockfile validation and an npm packaging dry run.
- The Node 24 job uploads a `.tgz` as `npm-package-<commit SHA>` (retained for 14 days).
- Only a **version increase pushed to `main` in `oldflag2333333/pi-subagent`** triggers publication, after both check jobs pass. Ordinary pushes, PRs, manual CI runs, and tag pushes do not publish.

Publishing uses npm OIDC with provenance, reserves `v<version>` at the checked commit, and creates a GitHub Release. Stable versions use `latest`; prereleases use `next`.

## First npm release: 0.1.0

**npm requires the package to exist before a trusted publisher can be configured.** The first publish therefore needs your npm login, not OIDC. See [npm's prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/#prerequisites).

The npm package is **@oldflag2333333/pi-subagent**.

1. Enable 2FA on your npm account.
2. Push the intended release commit to `main`. Wait for the entire **CI and Release** run to succeed.
3. Download that run's `npm-package-<commit SHA>` artifact and extract it. Use a trusted `main` run, not a PR artifact.
4. In the extracted directory, run:

   ```bash
   npx --yes npm@11.21.0 login --registry=https://registry.npmjs.org
   npx --yes npm@11.21.0 publish ./oldflag2333333-pi-subagent-0.1.0.tgz --access public --ignore-scripts --registry=https://registry.npmjs.org
   ```

   Complete the browser/2FA prompts yourself. Do not send credentials or OTPs to an agent. The tarball is the exact package produced by CI; no need to repack it locally. This initial interactive publish does not have CI provenance and does not create a GitHub Release.

5. Verify:

   ```bash
   npm view @oldflag2333333/pi-subagent version --registry=https://registry.npmjs.org
   ```

## Configure automatic publishing on npm

Open **npmjs.com → @oldflag2333333/pi-subagent → Settings → Trusted publishing → Add trusted publisher → GitHub Actions**:

| Field | Value |
| --- | --- |
| Organization or user | `oldflag2333333` |
| Repository | `pi-subagent` |
| Workflow filename | `release.yml` — filename only |
| Environment name | Leave empty |
| Allowed actions | Enable direct `npm publish`, not just staged publishing |

No `NPM_TOKEN` or other npm secret is needed in GitHub. The workflow requests `id-token: write` and uses GitHub's built-in token for tags/releases.

A new trust configuration must complete a successful OIDC publish **within 2 days**, or it expires. Configure it when you are ready for the next version, or recreate it if it expires. After verifying OIDC publishing, npm recommends **Publishing access → Require two-factor authentication and disallow tokens**.

Source: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

## Subsequent releases

With a clean working tree:

```bash
npm version patch --no-git-tag-version
# From 0.1.0, this produces 0.1.1.
git add package.json package-lock.json
git commit -m "chore: release v0.1.1"
git push origin main
```

Use a PR instead if required by branch policy. Once the version bump reaches `main`, CI publishes npm and creates the tag and GitHub Release automatically. Do not publish locally again or pre-create the tag.

If publication fails, fix the external configuration and **re-run the original failed workflow**. An identical already-published artifact is not republished; conflicting artifacts or tags fail rather than overwrite existing releases. Never try to reuse an npm version for different contents. Publish one version at a time.
