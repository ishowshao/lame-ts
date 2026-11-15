# Releasing lame-ts

The npm package is `@ishowshao/lame-ts`; its executable remains `lame-ts`.
The regular release path follows Tinker: a reviewed commit on `main`, passing CI,
an immutable version tag, npm Trusted Publishing, and a GitHub Release.

## One-time setup

The npm package must exist before a Trusted Publisher can be configured. For the
first release only, publish a tested release candidate with an interactive npm
login and 2FA, using the `rc` dist-tag. Do not use a placeholder package or replace
`latest` with a prerelease. Record its source with a `bootstrap/vX.Y.Z-rc.N` tag;
that tag deliberately does not trigger the regular publishing workflow.

Then configure `@ishowshao/lame-ts`'s GitHub Trusted Publisher with:

- Owner: `ishowshao`
- Repository: `lame-ts`
- Workflow filename: `publish.yml`
- Environment: `npm-production`
- Permission: allow direct `npm publish`

Create the GitHub environment with a deployment policy allowing `v*` tags. The
workflow uses GitHub-hosted runners and `id-token: write`; it needs no npm token
secret. Newly configured trust must be exercised promptly by the first stable
release. Refer to the current [npm Trusted Publishing documentation](https://docs.npmjs.com/trusted-publishers/).

The first stable release and all later releases use the workflow below. Local
publishing is only for the initial bootstrap candidate, not the regular process.

## Prepare and validate

1. Update `package.json` and `package-lock.json` together with
   `npm version <version> --no-git-tag-version`.
2. Add the version's user-facing notes to `CHANGELOG.md`.
3. Run:

   ```sh
   npm ci
   npm run check
   npm run release:verify
   node scripts/release-notes.mjs v<version>
   git diff --check
   ```

`release:verify` builds and packs the actual package, checks its allowlist and
metadata, installs it into a temporary consumer project, compiles a TypeScript
consumer, and compares the installed one-shot API, streaming API, and CLI against
three C-reference hashes. It removes its temporary files afterwards.

To check an installed runtime other than the development Node.js:

```sh
LAME_TS_RUNTIME_NODE=/path/to/node npm run release:verify
```

The development scripts require Node.js >= 22.18. The built package supports
Node.js >= 18. CI runs the full check and package verifier on Linux/macOS with
Node.js 22 and 24.

Commit and push the release preparation to `main`. Wait for every CI job for that
exact commit to pass. Confirm the working tree is clean and the version does not
already exist on the official npm registry; distinguish a genuine 404 from a
network or authentication failure.

## Publish

Create an annotated tag pointing at the checked commit, then push it:

```sh
git tag -a v<version> <checked-commit> -m "lame-ts <version>"
git push origin v<version>
```

The workflow verifies that the tag matches the manifest, belongs to `main`, and
has changelog notes. It installs from the lockfile, repeats the quality gate,
and publishes the exact archive validated by `release:verify` with provenance.
Stable versions use `latest`; versions such as `0.2.0-rc.1` use `rc`.

After npm publishing, it waits up to 20 minutes for npm's publish-time scanning
and registry availability, then installs the public package and checks it again.
Scanning usually takes around five minutes and can exceed 15 minutes; see
[npm's scanning announcement](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/).
The GitHub Release is created from the changelog only after these checks succeed.

## Verify completion

```sh
npm view @ishowshao/lame-ts@<version> version dist-tags dist.integrity dist.attestations --json
npm run release:verify -- --package @ishowshao/lame-ts@<version>
gh release view v<version> --repo ishowshao/lame-ts
git status --short
git rev-parse HEAD origin/main
```

Verify the provenance identifies `ishowshao/lame-ts`, `publish.yml`, the intended
tag, and the checked commit. Confirm the expected npm dist-tag and GitHub Release
state. A successful upload alone does not complete a release.

Never move or overwrite a pushed release tag or reuse a published npm version.
If authentication/configuration fails before publication, fix it and rerun the
same workflow. If npm succeeded but a later verification or GitHub Release step
failed, verify the existing package and finish the missing steps; do not publish
the same version again. Source fixes after a pushed tag require a new version.
