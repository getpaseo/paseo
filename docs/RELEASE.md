# Release

All workspaces share one version and release together.

## Two paths

There are two supported ways to ship from `main`:

1. **Direct stable release**: you are ready to ship the current `main` commit to everyone immediately.
2. **Release candidate flow**: you want public test builds first, but you are not ready for the website, npm, or production mobile release flows to move yet.

## Standard release (patch)

Before running any stable patch release command:

- Make sure the intended release commit is already committed to `main` and the working tree is clean.
- Make sure local `npm run typecheck` passes on that commit.
- Do not use `npm run release:patch` as a substitute for checking whether the current commit is actually ready.

```bash
npm run release:patch
```

This bumps the version across all workspaces, runs checks, publishes to npm, and pushes the branch + tag (triggering desktop, APK, and EAS mobile workflows).

If asked to "release paseo" without specifying major/minor, treat it as a patch release.

Use the direct stable path when the current `main` changes are ready to become the public release immediately.

## Manual step-by-step

```bash
npm run typecheck            # Verify the exact commit you intend to release
npm run release:check        # Typecheck, build, dry-run pack
npm run version:all:patch    # Bump version, create commit + tag
npm run release:publish      # Publish to npm
npm run release:push         # Push HEAD + tag (triggers CI workflows)
```

## Release candidate flow

```bash
npm run release:rc:patch       # Bump to X.Y.Z-rc.1, push commit + tag
# ... test desktop and APK prerelease assets from GitHub Releases ...
npm run release:rc:next        # Optional: cut X.Y.Z-rc.2, rc.3, ...
npm run release:promote        # Promote X.Y.Z-rc.N to stable X.Y.Z
```

- RC tags are published GitHub prereleases like `v0.1.41-rc.1`
- RCs publish desktop assets and APKs for testing, but they do not publish npm packages and do not trigger the production web/mobile release flows
- `release:promote` creates a fresh stable tag like `v0.1.41`; the final release never reuses the RC tag
- Desktop assets now come from the Electron package at `packages/desktop`
- **Do NOT create a changelog entry for RCs.** The changelog remains stable-only. RC release notes are generated automatically so the website stays pinned to the latest published stable release.

Use the RC path when you need to:

- test a build manually in a Linux or Windows VM
- send a build to a user who is hitting a specific problem
- iterate on `rc.1`, `rc.2`, `rc.3`, and so on before deciding to ship broadly

## Website behavior

- The website download page points to GitHub's latest published **stable** release.
- Published RC prereleases are public on GitHub Releases, but they do **not** become the website download target.
- The website only moves when you publish the final stable release tag like `v0.1.41`.

## Fixing a failed release build

**NEVER bump the version to fix a build problem.** New versions are reserved for meaningful product changes (features, fixes, improvements). Build/CI failures are fixed on the current version.

**Do not rely on `workflow_dispatch` for tagged code fixes.** The `workflow_dispatch` trigger runs the workflow file from the default branch but checks out the code at the tag ref (`ref: ${{ inputs.tag }}`). That means fixes committed to `main` won't change the tagged source tree being built. `workflow_dispatch` only helps when the fix lives in the workflow file itself.

To retry a failed workflow, **always push a retry tag** on the commit you want to build. Reusing the same tag name is expected: move it with `git tag -f ...` and push it with `--force` so the workflow rebuilds the commit you actually want.

Prefer a tag push over `workflow_dispatch` whenever you are rebuilding release code or release assets.

The retry tag patterns below still work and remain the supported way to rebuild specific release targets:

```bash
# Desktop (all platforms)
git tag -f desktop-v0.1.28 HEAD && git push origin desktop-v0.1.28 --force

# Desktop (single platform)
git tag -f desktop-macos-v0.1.28 HEAD && git push origin desktop-macos-v0.1.28 --force
git tag -f desktop-linux-v0.1.28 HEAD && git push origin desktop-linux-v0.1.28 --force
git tag -f desktop-windows-v0.1.28 HEAD && git push origin desktop-windows-v0.1.28 --force

# Android APK
git tag -f android-v0.1.28 HEAD && git push origin android-v0.1.28 --force

# RC
git tag -f v0.1.29-rc.2 HEAD && git push origin v0.1.29-rc.2 --force
```

This ensures the checkout ref matches the actual code on `main` with the fix included.

- `vX.Y.Z` or `vX.Y.Z-rc.N` rebuilds the full tagged release
- `desktop-vX.Y.Z` rebuilds desktop for all desktop platforms only
- `desktop-macos-vX.Y.Z`, `desktop-linux-vX.Y.Z`, and `desktop-windows-vX.Y.Z` rebuild only that desktop platform
- `android-vX.Y.Z` rebuilds the Android APK release only

## Notes

- `version:all:*` bumps root + syncs workspace versions and `@getpaseo/*` dependency versions
- `release:prepare` refreshes workspace `node_modules` links to prevent stale types
- `npm run dev:desktop` and `npm run build:desktop` target the Electron desktop package in `packages/desktop`
- If `release:publish` partially fails, re-run it — npm skips already-published versions
- The website uses GitHub's latest published release API for download links, so published RC prereleases do not replace the stable download target.

## Changelog format

Stable release notes depend on the changelog heading format. The heading **must** be strictly followed:

```
## X.Y.Z - YYYY-MM-DD
```

No prefix (`v`), no extra text. The parser matches the first `## X.Y.Z` line to extract the version. A malformed heading will break download links on the homepage.

## Changelog policy

- `CHANGELOG.md` is for **final stable releases only**.
- Do not add or edit changelog entries while iterating on RCs.
- Write the proper changelog entry when you are cutting the final stable release that comes after the RC cycle.
- Between stable releases, keep changelog work out of the repo until the final release is ready.

## Changelog ownership

- **Only Claude should write changelog entries.**
- If you are Codex and a stable release needs a changelog entry, launch a Claude agent with Paseo to draft it, then review and commit the result.

## Changelog voice

The changelog is shown on the Paseo homepage. Write it for **end users**, not developers.

- **Frame everything from the user's perspective.** Describe what changed in the app, not what changed in the code. Users care that "workspaces load instantly" — not that a component no longer remounts.
- **Never mention component names, internal modules, or implementation details.** No `WorkingIndicator`, no `accumulatedUsage`, no `reconcileAndEmitWorkspaceUpdates`.
- **Collapse internal iterations.** If a feature was added and then fixed within the same release, just list the feature as working. Users never saw the broken version.
- **Only list changes relative to the previous stable release.** The diff is `v(previous)..HEAD`. If something was introduced and fixed between those two tags, it never shipped — don't mention the fix.
- **Cut low-signal entries.** "Toolbar buttons have consistent sizing" is too granular. Combine small polish items or drop them.

## Changelog attribution

Every changelog bullet must credit contributors and link to the PR(s) that delivered the change. This is not one-PR-per-line — a single bullet describes a user-facing change and may reference multiple PRs.

Format: append `([#123](https://github.com/getpaseo/paseo/pull/123) by [@user](https://github.com/user))` at the end of each bullet. For changes spanning multiple PRs or contributors:

```markdown
- Voice mode now works on tablets with proper microphone permissions. ([#210](https://github.com/getpaseo/paseo/pull/210), [#215](https://github.com/getpaseo/paseo/pull/215) by [@alice](https://github.com/alice), [@bob](https://github.com/bob))
```

Rules:

- **Always link the PR number** as `[#N](https://github.com/getpaseo/paseo/pull/N)`.
- **Always link the contributor's GitHub profile** as `[@user](https://github.com/user)`.
- **One bullet = one user-facing change**, regardless of how many PRs went into it. Group related PRs on the same bullet.
- **De-duplicate contributors.** If the same person authored multiple PRs in one bullet, list them once.
- **Only credit external contributors.** Skip attribution for [@boudra](https://github.com/boudra). The changelog credits community contributions — core team work is the default.
- **Use `git log` to find PR numbers and authors.** PR numbers are typically in the commit message as `(#N)`. Use `gh pr view N --json author` if the commit doesn't include the GitHub username.

## Changelog ordering

Entries within each section (Added, Improved, Fixed) are ordered by user impact:

1. **User-facing features and changes first** — things users will notice, want to try, or that change their workflow.
2. **Quality-of-life improvements** — polish, performance, smoother interactions.
3. **Internal/infra changes last** — only include if they have a tangible user benefit (e.g. "faster startup" is user-facing even if the fix was internal).

## Pre-release sanity check

Before cutting any release (RC or stable), run a Codex review of the diff as a last line of defence against shipping bugs.

Load the `paseo` skill and launch a **Codex 5.4** agent with a prompt like:

> Review the diff between the latest release tag and HEAD. Focus on:
>
> 1. **Breaking changes** — especially in the WebSocket protocol, agent lifecycle, and any server↔client contract.
> 2. **Backward compatibility** — the important direction is old app clients talking to newly updated daemons. Users update desktop and daemon first, then keep running the old app for a while. Flag anything that breaks old clients against new daemons or requires both sides to update in lockstep.
> 3. **Regressions** — anything that looks like it could break existing functionality.
>
> Diff: `git diff <latest-release-tag>..HEAD`

The agent's job is a deep sanity check, not a full code review. If it flags anything, investigate before proceeding.

## Changelog scope

The changelog always covers **stable-to-HEAD**:

- **RC release**: the diff and release notes cover `latest stable tag → HEAD`. RC release notes are auto-generated and not added to `CHANGELOG.md`.
- **Stable release**: the diff and changelog entry cover `latest stable tag → HEAD`. Any intermediate RCs are skipped — the changelog captures the full delta from the previous stable release, not just what changed since the last RC.

In other words, RCs are checkpoints along the way; the changelog only records the final jump from one stable version to the next.

## Completion checklist

- [ ] Run the pre-release sanity check (see above) and address any findings
- [ ] Ensure the intended release commit is already committed and the git worktree is clean before running any `release:*` patch/promote command
- [ ] Ensure local `npm run typecheck` passes on that exact commit before running any `release:*` patch/promote command
- [ ] Update `CHANGELOG.md` with user-facing release notes (features, fixes — not refactors)
- [ ] Verify the changelog heading follows strict `## X.Y.Z - YYYY-MM-DD` format
- [ ] `npm run release:patch` or `npm run release:promote` completes successfully
- [ ] GitHub `Desktop Release` workflow for the `v*` tag is green
- [ ] GitHub `Android APK Release` workflow for the same tag is green
- [ ] EAS `release-mobile.yml` workflow for the same tag is green
