# Release

All workspaces share one version and release together.

## Two steps

A release has exactly two steps. The agent does the first, the user authorizes the second.

**Preparation** (local, reversible — agent does this):

- format, lint, typecheck all green
- draft the changelog, show it to the user, wait for review
- run the pre-release sanity check, surface findings to the user
- confirm CI is green

**Go-ahead** (user says "go ahead"):

- commit the approved changelog
- run the release

Rules that apply to both steps:

- Last-minute changes always need approval. Every time.
- No code changes bundled into the changelog commit or the release commit. Code shims live in their own commit, reviewed on their own merits.
- A sanity-check finding is information, not a directive. The agent surfaces it; the user decides.
- Invoking a release skill is intent to start the flow, not blanket authorization to publish.

## Two paths

There are two supported ways to ship from `main`:

1. **Direct stable release**: you are ready to ship the current `main` commit to everyone immediately.
2. **Beta flow**: silent release candidates. Betas don't touch the changelog, don't move the website, and don't publish npm or production mobile builds.

## Standard release (patch)

Before running any stable patch release command:

- Make sure the intended release commit is already committed to `main` and the working tree is clean.
- **Run `npm run format`, `npm run lint`, and `npm run typecheck` and commit any resulting changes BEFORE you start any `release:*` command.** `release:check` runs `npm install --workspaces --include-workspace-root` as part of `release:prepare`, which can mutate `package-lock.json` (e.g. churning `"dev": true` markers on optional deps). The next step, `version:all:*`, runs `npm version` which aborts when the working tree is dirty. If this happens mid-flight you have to commit the lockfile churn before retrying — and the pre-commit format hook will reject a lockfile-only commit because oxfmt internally skips `package-lock.json` while lefthook's glob still matches it. Avoid the whole mess by running format/lint/typecheck first, then `release:prepare` once on its own to absorb any lockfile churn into a normal commit, then start the release.
- Do not use `npm run release:patch` as a substitute for checking whether the current commit is actually ready.

```bash
npm run release:patch
```

This bumps the version across all workspaces, runs checks, publishes to npm, and pushes the branch + tag. The tag push triggers `Desktop Release`, `Android APK Release`, and `Release Notes Sync` on GitHub Actions. EAS picks up the same tag via the EAS GitHub app and starts the iOS + Android store builds in parallel (see "Mobile builds (EAS)" below) — there is no `release-mobile.yml` in this repo.

**Releases are always patch.** "Release paseo", "release stable", "ship stable", and similar always mean a patch bump from the previous stable. Never bump minor or major to trigger a build, ever — minor and major bumps are reserved for genuinely larger product cuts and require an explicit user instruction with the word "minor" or "major". If you find yourself reaching for `release:minor` to retrigger a failed build, you are doing the wrong thing — push a retry tag instead (see "Fixing a failed release build" below).

**Stable means stable.** If the user says "stable" or "ship stable", do not ask whether they want a beta first. They picked stable; treat it as a direct stable release. Only run the beta flow when the user explicitly says "beta".

## Manual step-by-step

```bash
npm run typecheck            # Verify the exact commit you intend to release
npm run release:check        # Typecheck, build, dry-run pack
npm run version:all:patch    # Bump version, create commit + tag
npm run release:publish      # Publish to npm
npm run release:push         # Push HEAD + tag (triggers CI workflows)
```

## Beta flow

```bash
npm run release:beta:patch       # Bump to X.Y.Z-beta.1, push commit + tag
# ... test desktop and APK prerelease assets from GitHub Releases ...
npm run release:beta:next        # Optional: cut X.Y.Z-beta.2, beta.3, ...
npm run release:promote          # Promote X.Y.Z-beta.N to stable X.Y.Z
```

- Beta tags are published GitHub prereleases like `v0.1.41-beta.1`
- Betas publish desktop assets and APKs for testing, but they do not publish npm packages and do not trigger the production web/mobile release flows
- `release:promote` creates a fresh stable tag like `v0.1.41`; the final release never reuses the beta tag
- Desktop assets now come from the Electron package at `packages/desktop`
- Beta releases use Electron's `beta` update channel. Users on the stable channel only receive stable releases; users on the beta channel receive beta releases and the final stable release when it is published.
- **Betas don't touch `CHANGELOG.md`.** Beta GitHub releases ship with empty notes — that's intentional. The changelog entry is written once, at promotion time, covering the full stable-to-stable diff. The release-notes sync script skips betas cleanly because no matching section exists.

Use the beta path when you need to:

- smoke a build yourself before promoting it to everyone
- test a build manually in a Linux or Windows VM
- send a build to a user who is hitting a specific problem
- iterate on `beta.1`, `beta.2`, `beta.3`, and so on before deciding to ship broadly

## Staged rollout (stable channel)

Stable desktop releases go out via a linear time-based rollout: 0% admitted when the updater manifests appear, 100% admitted 36 hours later, linear ramp in between. Beta releases bypass the rollout entirely — beta users always receive updates immediately.

The rollout is driven by a `rolloutHours` field stamped into the GitHub Release manifests (`latest-mac.yml`, `latest-linux.yml`, `latest.yml`) by the `finalize-rollout` job in `desktop-release.yml`.

Desktop release builds now publish in two phases:

- Platform build jobs upload the installers/packages (`.dmg`, `.zip`, `.exe`, `.AppImage`, etc.) to the GitHub release.
- The final job merges/stamps the manifests and uploads all `.yml` files only after they already contain the final `releaseDate` and `rolloutHours`.

Updater clients only discover a release through those `.yml` manifests, so there is no silent 100% admission window before rollout metadata is present.

### Default behavior

`npm run release:patch` → tag push → 36h ramp. No extra action needed.

The `rollout_hours` input on `desktop-release.yml` is **only read on `workflow_dispatch`** — tag-push runs always default to 36. To get any other rollout duration on a fresh release, use the post-publish flip below.

### Instant-admit release (rollout_hours=0 from publish)

For a fresh release that should admit everyone immediately (low-risk change, doc-only, hotfix, or just a release you want out fast), cut the release normally and queue the rollout flip immediately after:

```bash
# 1. Cut and publish (default 36h ramp from tag push).
npm run release:patch

# 2. Immediately queue the flip — runs as soon as finalize-rollout completes.
gh workflow run desktop-rollout.yml \
  -f tag=v0.1.64 \
  -f rollout_hours=0
```

**Why this is gap-free:** `desktop-release.yml`'s `finalize-rollout` job and `desktop-rollout.yml` share the concurrency group `desktop-rollout-<tag>`. Dispatching `desktop-rollout.yml` while the tag-push pipeline is still running queues it safely behind `finalize-rollout`. The first public manifests already carry `rolloutHours=36`, then `desktop-rollout.yml` flips them to `rolloutHours=0` shortly afterward. The renderer polls every 30 minutes, so active stable users pick up the new manifest on their next check.

Run the dispatch right after `release:patch` returns. Don't wait for the tag-push CI to finish.

### Adjusting an already-published release

To change the rollout duration on a release that's already shipped — e.g. flip a hotfix to instant admit, or slow a release down — use the dedicated `desktop-rollout.yml` workflow. It edits the manifests in place on the GitHub release without rebuilding anything. It only rewrites `rolloutHours`; `releaseDate` is preserved, so the rollout clock keeps ticking from the original publish time.

**Hotfix (instant admit) on an already-shipped release:**

```bash
gh workflow run desktop-rollout.yml \
  -f tag=v0.1.42 \
  -f rollout_hours=0
```

`rollout_hours=0` admits 100% of stable users on their next update check (within ~30 min for active clients).

**Slow a rollout down** (e.g. extend total duration to 72h since the original release):

```bash
gh workflow run desktop-rollout.yml \
  -f tag=v0.1.42 \
  -f rollout_hours=72
```

`rollout_hours` is **total duration since the original release date**, not "extend by N more hours from now." If `v0.1.42` was published 2h ago and you set `rollout_hours=72`, the ramp finishes 70h from now.

The dispatch is idempotent and shares the `desktop-rollout-<tag>` concurrency group with `desktop-release.yml`'s `finalize-rollout` job, so it serializes safely against an in-flight tag-push pipeline targeting the same release.

### Custom ramp on a manually-dispatched build

`desktop-release.yml` accepts `rollout_hours` only on `workflow_dispatch`, which is the path used to **rebuild an existing tag** (retry a failed release, force a rebuild on a different ref). When you go that route, you can stamp a non-default ramp directly:

```bash
gh workflow run desktop-release.yml \
  -f tag=v0.1.43 \
  -f rollout_hours=6
```

This does **not** apply to fresh releases cut via `npm run release:patch` — that path always tag-pushes and stamps 36. For a fresh release with a custom ramp, cut normally and then dispatch `desktop-rollout.yml` (same pattern as the instant-admit flow above, with your chosen `rollout_hours`).

### Releasing during an active rollout

If you ship N+1 while N is still ramping, N+1 starts a fresh rollout from its own publish timestamp. N's rollout effectively ends — the newer manifest supersedes it.

If N+1 is a hotfix for a bug in N, dispatch `desktop-rollout.yml -f tag=v0.1.<N+1> -f rollout_hours=0` after N+1 publishes so the users who already got N reach the fix fast.

### Limitations

- **No pause / kill switch.** Once a stable user is admitted, they will install the update on next quit (`autoInstallOnAppQuit = true`). To stop new admissions, ship a superseding release. To "recall" already-admitted users, ship a hotfix `+1` patch.
- **No rollback.** `allowDowngrade = false`. Bad release = ship a hotfix.
- **Bootstrap caveat.** Clients running a build older than the rollout feature ignore `rolloutHours` and admit immediately. Rollout protection only applies to clients running the rollout-aware version or later.
- **Up to ~30 min admission latency.** Renderer polls every 30 minutes, so a stable user may take up to that long to be evaluated against the rollout window.

## Mobile builds (EAS)

iOS and Android store builds are not in `.github/workflows`. They are triggered by the EAS GitHub app the moment the `v*` tag is pushed:

- **Android (Play Store)** — EAS builds with profile `production` and auto-submits to the Play Store via `eas submit` (EAS-managed credentials, no Fastlane).
- **iOS (TestFlight + App Store)** — EAS builds with profile `production`, uploads to TestFlight, and a Fastlane lane submits the build for App Store review.
- **Android APK (GitHub Release asset)** — separate, via `.github/workflows/android-apk-release.yml`. This is the only Android-related workflow that lives in this repo.

There is no `release-mobile.yml` in this repo. Earlier versions of these docs referenced one — that workflow was removed and the EAS GitHub app handles tag triggering directly.

### Watching mobile builds from the terminal

Use the EAS CLI from `packages/app/`:

```bash
cd packages/app

# Recent builds (newest first). Pipe to jq for status only.
npx eas build:list --limit 8 --non-interactive --json | jq '.[] | {platform, status, appVersion, gitCommitHash}'

# Recent EAS workflow runs. This is the source of truth for submit/review jobs.
npx eas workflow:runs --json | jq '.[] | {status, workflowName, trigger, gitCommitHash, startedAt, finishedAt}'

# Filter by platform.
npx eas build:list --platform ios --limit 5 --non-interactive --json
npx eas build:list --platform android --limit 5 --non-interactive --json

# Inspect a specific build.
npx eas build:view <build-id>

# Inspect the full release workflow, including submit_ios, submit_android,
# and submit_ios_for_review.
npx eas workflow:view <workflow-run-id> --json

# Read failed submit/review job logs.
npx eas workflow:logs <workflow-job-id> --all-steps --non-interactive

# Stream logs for a build.
npx eas build:view <build-id> --json | jq '.logFiles[]'
```

A build's `gitCommitHash` must match the release tag commit. `status` walks through `NEW` → `IN_QUEUE` → `IN_PROGRESS` → `FINISHED` (or `ERRORED`/`CANCELED`). The EAS workflow run's `gitCommitHash` and `trigger` must also match the release tag.

Once a build is `FINISHED`, EAS still has release-critical work to do: Android must submit to the Play Store, and iOS must upload to TestFlight **and** submit the build for App Store review. The release is not done until all platforms are on their way through the stores.

For the `Release Mobile` EAS workflow, these jobs must pass:

- `build_ios` — iOS binary built
- `submit_ios` — iOS binary uploaded to App Store Connect/TestFlight
- `submit_ios_for_review` — iOS build submitted for App Store review via Fastlane
- `build_android` — Android store binary built
- `submit_android` — Android binary submitted to the Play Store

Do not treat `build_ios: SUCCESS` or `submit_ios: SUCCESS` as a completed iOS release. `submit_ios_for_review: FAILURE` means the iOS release is blocked even if the build is visible in TestFlight.

To confirm the submission landed, inspect the EAS workflow with `npx eas workflow:view <workflow-run-id> --json`. App Store Connect (review state for the matching version/build) and the Play Console track are the final ground truth.

### Babysitting mobile after a release

The user rarely opens the Expo dashboard. A failed EAS build or submit/review job can sit silently until users complain about a stale version. After every stable release, set up a long-delay babysit that re-checks GitHub Actions, EAS builds, and the EAS `Release Mobile` workflow for the release tag. If any build is `ERRORED`/`CANCELED`, any workflow is `FAILURE`, or any required submit/review job fails, surface it immediately. If all builds are `FINISHED` and all required submit/review jobs are `SUCCESS`, confirm and stop.

**Use `create_heartbeat`, never `create_schedule`, for release babysitting.** Babysitting fires back into the current conversation as a wake-up prompt. `create_schedule` starts a fresh agent the user has to find and read; `create_heartbeat` surfaces the build status inline in the conversation that owns the release, where it is impossible to miss. If you find yourself reaching for `create_schedule` for a release babysit, you are about to ship a status report into a void.

Pattern:

```jsonc
// mcp__paseo__create_heartbeat arguments
{
  "name": "vX.Y.Z release babysit heartbeat",
  "cron": "*/15 * * * *",
  "maxRuns": 8, // covers ~2h of build + store-submission window
  "prompt": "Heartbeat: check vX.Y.Z release. Run gh run list, eas build:list, eas workflow:runs, and eas workflow:view for the matching Release Mobile run. Report concisely. The release is not done until desktop/APK workflows are green, EAS builds are FINISHED, Android submit_android is SUCCESS, and iOS submit_ios + submit_ios_for_review are SUCCESS. Flag any ERRORED/FAILED/CANCELED/FAILURE loudly.",
}
```

Tight cadence on purpose. The first run fires immediately, giving a near-real-time status check before the conversation closes. Subsequent runs at 15-minute intervals catch transitions quickly: a failed EAS build or failed App Store review submission at +20m should not wait until +50m to surface. Keep the prompt short — the heartbeat is a status probe, not a research task — and have it bail out as soon as every platform is actually on its store path so the remaining runs do not generate noise.

## Release notes on GitHub

The GitHub Release body is populated automatically by the `Release Notes Sync` workflow (`.github/workflows/release-notes-sync.yml`). It triggers on every `v*` tag push and on any push to `main` that touches `CHANGELOG.md`, then runs `scripts/sync-release-notes-from-changelog.mjs` to mirror the matching changelog entry into the release body. You don't need to write release notes on GitHub manually — keep `CHANGELOG.md` correct and the workflow will sync it. To force a re-sync, dispatch the workflow with the tag input.

## Website behavior

- The website download page points to GitHub's latest published **stable** release.
- Published beta prereleases are public on GitHub Releases, but they do **not** become the website download target.
- The website only moves when you publish the final stable release tag like `v0.1.41`.
- The website itself is deployed by `Deploy Website` (Cloudflare Workers), which redeploys on `release: published` for non-prerelease releases and on pushes to `main` that touch `CHANGELOG.md` or `packages/website/**`.

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

# Beta
git tag -f v0.1.29-beta.2 HEAD && git push origin v0.1.29-beta.2 --force
```

This ensures the checkout ref matches the actual code on `main` with the fix included.

- `vX.Y.Z` or `vX.Y.Z-beta.N` rebuilds the full tagged release
- `desktop-vX.Y.Z` rebuilds desktop for all desktop platforms only
- `desktop-macos-vX.Y.Z`, `desktop-linux-vX.Y.Z`, and `desktop-windows-vX.Y.Z` rebuild only that desktop platform
- `android-vX.Y.Z` rebuilds the Android APK release only

## Notes

- `version:all:*` bumps root + syncs workspace versions and `@getpaseo/*` dependency versions
- `release:prepare` refreshes workspace `node_modules` links to prevent stale types
- `npm run dev:desktop` and `npm run build:desktop` target the Electron desktop package in `packages/desktop`
- If `release:publish` partially fails, re-run it — npm skips already-published versions
- The website uses GitHub's latest published release API for download links, so published beta prereleases do not replace the stable download target.

## Changelog format

Release notes depend on the changelog heading format. The heading **must** be strictly followed:

```
## X.Y.Z - YYYY-MM-DD
```

No prefix (`v`), no extra text. The parser matches the first `## X.Y.Z` line to extract the version. A malformed heading will break download links on the homepage.

## Changelog policy

- `CHANGELOG.md` only lists stable releases. Betas are silent.
- The changelog entry is authored once, at stable promotion time, with the date set to the promotion day.
- It covers the full diff from the previous stable tag, regardless of how many betas were cut in between.

## Changelog ownership

- **The agent running the stable release writes the changelog entry.** Do not hand the changelog to another model or agent. The release agent has the release context and owns the final wording.
- Draft the entry from the stable-to-stable diff, review it against the changelog policy below, show it to the user, and wait for approval before committing it.

## Changelog voice

The changelog is shown on the Paseo homepage. Write it for **end users**, not developers.

- **Frame everything from the user's perspective.** Describe what changed in the app, not what changed in the code. Users care that "workspaces load instantly" — not that a component no longer remounts.
- **Never mention component names, internal modules, or implementation details.** No `WorkingIndicator`, no `accumulatedUsage`, no `reconcileAndEmitWorkspaceUpdates`. Also no "virtualized lists", no "remount", no "memoization", no "debounced", no "fuzzy ranking", no "controlled input", no "uncontrolled input" — these are implementation words masquerading as user-facing copy.
- **Concrete WRONG → RIGHT examples** (real mistakes from past releases):

  | Wrong (implementation-facing)                                                       | Right (user-facing)                                         |
  | ----------------------------------------------------------------------------------- | ----------------------------------------------------------- |
  | Switching layouts no longer remounts the active agent                               | Splitting a pane no longer loses your scroll position       |
  | Model, mode, and thinking pickers — searchable virtualized lists with fuzzy ranking | Mobile model selector is faster and more straightforward    |
  | Text inputs in mobile sheets no longer flicker while typing fast                    | Typing in mobile sheets no longer flickers                  |
  | Compact web sheets no longer crash when swiped to dismiss                           | Sheets on mobile web no longer crash when swiped to dismiss |
  | Reduced re-renders in the agent list                                                | Agent list scrolls smoothly                                 |
  | Added debouncing to the search input                                                | Search results no longer lag behind typing                  |

  Test: would a non-developer reader recognise what changed when using the app? If they'd need an engineer to translate ("what's a remount?"), the bullet is still implementation-facing — rewrite it as the symptom the user experiences.

- **Collapse internal iterations.** If a feature was added and then fixed within the same release, just list the feature as working. Users never saw the broken version.
- **Only list changes relative to the previous stable release.** The diff is `v(previous)..HEAD`. If something was introduced and fixed between those two tags, it never shipped — don't mention the fix.
  - **Common trap:** when drafting from `git log`, every commit looks like a separate bullet — including the "fix X" commits that landed on top of a brand-new feature in the same release window. Before listing a Fixed entry, check whether the thing being fixed was itself added in this same release. If so, drop the fix and fold it into the feature bullet.
  - **Example:** if the release adds an in-app browser and also contains a commit "fix: browser pane keyboard handling no longer steals shortcuts", do **not** list the keyboard fix under Fixed. The browser is shipping for the first time, so users will only ever see the working version. The Added entry covers it.
- **Cut low-signal entries.** "Toolbar buttons have consistent sizing" is too granular. Combine small polish items or drop them.

## Changelog conciseness

Every bullet must be scannable at a glance. The changelog is not release documentation — it's a list.

- **One sentence per bullet, max.** If a bullet contains two sentences, the second one is doing work that belongs in product docs, not the changelog. Cut it.
- **No trailing periods.** Bullets are list items, not prose. Drop the period at the end of every bullet, including the period inside any bolded lead-in. `**Configurable terminal scrollback**` not `**Configurable terminal scrollback.**`.
- **One line per bullet.** If a bullet wraps to three lines in a narrow column, it's too long.
- **Split bullets that pack multiple distinct changes.** If a bullet uses "and", "plus", a comma list, or an em-dash to chain several independent improvements, break them into separate bullets — even when they share a theme or author. One bullet = one user-facing change.
- **Trim qualifying clauses.** Drop "with a hint shown when…", "matching the CLI's behaviour", "across common install shapes". If the detail doesn't change whether a user cares, cut it.
- **Lead with what the user can do, not the mechanism.** The reader cares about the capability, not how it works under the hood. Do not explain LAN vs WAN, TLS handshakes, IPC, the daemon-relay topology, or any internal concept the user has not asked about. "Self-hosted relays can use a different TLS setting for the public endpoint" — not "Self-hosted relays support a separate TLS setting for the public endpoint, so the daemon can reach the relay over the LAN while the phone reaches it over the public secure address." If a feature genuinely needs background to be understood, it belongs in product docs, with a one-line teaser in the changelog.
- **Lead with the outcome.** "Windows: agents launch reliably from npm `.cmd` shims…" is better than "Windows: agents launch reliably across common install shapes. Claude, Codex, and OpenCode now start correctly…".
- **Attribution follows the split.** When you split a dense bullet, move each PR/author to the bullet it belongs to. Never duplicate the same PR across multiple bullets.

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
- **Credit the commit author, not the PR opener.** A maintainer often opens a PR that lands work authored by someone else (cherry-pick, rebase of a contributor's branch, manual extraction from a stacked PR). The squash commit preserves the original commit's author, but `gh pr view N --json author` returns the PR opener — using that field will silently mis-credit the work to the maintainer (and then the "skip @boudra" rule drops the attribution entirely). Always resolve attribution from commit authors.

  Use this command to get the GitHub logins for each PR:

  ```bash
  gh pr view N --json commits --jq '[.commits[].authors[].login] | unique | .[]'
  ```

  This returns every distinct GitHub login that authored or co-authored a commit in the PR. Use those logins for attribution. Fall back to `gh pr view N --json author` only if the commits command returns nothing (which should not happen for merged PRs).

  When listing PR numbers, `git log --format='%H %s' v<previous>..HEAD | grep -E '\(#[0-9]+\)$'` pulls the PR number out of squash commit subjects.

## Changelog ordering

Entries within each section (Added, Improved, Fixed) are ordered by user impact:

1. **User-facing features and changes first** — things users will notice, want to try, or that change their workflow.
2. **Quality-of-life improvements** — polish, performance, smoother interactions.
3. **Internal/infra changes last** — only include if they have a tangible user benefit (e.g. "faster startup" is user-facing even if the fix was internal).

## Pre-release sanity check

Before cutting a **stable** release, the release agent reviews the diff as a last line of defence against shipping bugs. Skip this for betas — the beta itself is the smoke test, and gating each beta on a code review defeats the point of using betas as fast release candidates.

Review the diff between the latest release tag and `HEAD`. Focus on:

1. **Breaking changes** — especially in the WebSocket protocol, agent lifecycle, and any server↔client contract.
2. **Backward compatibility** — the important direction is old app clients talking to newly updated daemons. Users update desktop and daemon first, then keep running the old app for a while. Flag anything that breaks old clients against new daemons or requires both sides to update in lockstep.
3. **Regressions** — anything that looks like it could break existing functionality.

Use `git diff <latest-release-tag>..HEAD` as the review input. This is a deep sanity check, not a full code review. If anything looks risky, investigate before proceeding and surface the finding to the user.

## Changelog scope

The changelog covers **stable-to-stable**. Betas are not represented. When you promote, draft the entry from the diff between the previous stable tag and `HEAD`, ignoring beta tag boundaries — they're just checkpoints along the way.

## Completion checklist

### Beta release

- [ ] Working tree is clean and the intended commit is on `main`
- [ ] `npm run release:beta:patch` (or `:next`) completes successfully
- [ ] GitHub `Desktop Release` workflow for the `v*-beta.N` tag is green
- [ ] GitHub `Android APK Release` workflow for the same tag is green

### Stable release (or promotion)

- [ ] Run the pre-release sanity check (see above) and address any findings
- [ ] Ensure the intended release commit is already committed and the git worktree is clean before running any `release:*` patch/promote command
- [ ] Ensure local `npm run typecheck` passes on that exact commit before running any `release:*` patch/promote command
- [ ] Update `CHANGELOG.md` with user-facing release notes (features, fixes — not refactors)
- [ ] Verify the changelog heading follows strict `## X.Y.Z - YYYY-MM-DD` format
- [ ] `npm run release:patch` or `npm run release:promote` completes successfully
- [ ] GitHub `Desktop Release` workflow for the `v*` tag is green
- [ ] GitHub `Android APK Release` workflow for the same tag is green
- [ ] EAS `Release Mobile` workflow for the same tag is green
- [ ] EAS iOS `build_ios` completes for the same tag
- [ ] EAS iOS `submit_ios` succeeds, uploading the build to App Store Connect/TestFlight
- [ ] EAS iOS `submit_ios_for_review` succeeds, putting the build into App Store review
- [ ] EAS Android `build_android` completes for the same tag
- [ ] EAS Android `submit_android` succeeds, putting the build on its Play Store track
