# The team fork

`totally-tim/paseo` is a permanent fork of `getpaseo/paseo`. It carries features upstream will
not take, pulls upstream in about once a week, and ships its own desktop builds from its own
release feed. Read this before you branch, merge upstream, build a desktop app, or wonder why
the installed app says 1.x while the repo says 0.7.x.

## What the fork carries

Keep this list current. When upstream ships an equivalent, drop the fork change in the same
sync PR and remove its line here.

| Change                                                           | Where it lives                                                                                                                               | Why it is not upstream                                                                                                   |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Project groups in the sidebar                                    | core: `packages/app`, `packages/server`, `packages/protocol`                                                                                 | Upstream PR [#4246](https://github.com/getpaseo/paseo/pull/4246) is a draft that will not merge. Settled, do not reopen. |
| Kanban board plugin example and the host hooks it needs          | `plugin-examples/inbox`, small hooks in `packages/app/src/plugins`, `packages/client`, `packages/plugin`                                     | Fork-side experiment, not offered upstream                                                                               |
| Attachment menu opens the PR checkout                            | `packages/app/src/composer`                                                                                                                  | Fork-side change, not offered upstream                                                                                   |
| Fork identity: feed owner, drift check, this doc, the fork skill | `packages/desktop/electron-builder.yml`, `.github/workflows/fork-upstream-drift.yml`, `scripts/fork/`, `docs/fork.md`, `.agents/skills/fork` | Only meaningful on the fork                                                                                              |

Project groups cannot be a plugin. The plugin API contributes native surfaces, sidebar items,
workspace panels, Command Center items, slash commands, composer pills, attachment sources,
timeline items, themes and RPCs (`docs/plugins.md`). None of those reach the sidebar's project
list, the workspace descriptor, or the persisted project record, which is where grouping lives.

## Branches

`main` is the only long-lived branch and the default branch. It is upstream plus everything in
the table above. Feature branches go through a pull request into `main`. Never rebase `main`:
its history is published and every worktree hangs off it.

There is no upstream mirror branch. `upstream/main` on the `upstream` remote is the mirror:

```bash
git remote add upstream https://github.com/getpaseo/paseo.git   # once
git fetch upstream
```

Put new fork code where upstream never writes: a `plugin-examples/<name>` directory, a
`scripts/fork/` script, a `fork-*.yml` workflow. Core edits are sometimes unavoidable, as with
project groups, and every one of them is a line you resolve by hand on each sync.

## Syncing upstream

Merge upstream's latest release tag into `main` about once a week. Tags are tested states,
`upstream/main` between tags is not. Upstream cuts a release every one to three days, so
waiting longer than a week means a larger merge, not a rarer one.

```bash
git fetch upstream --tags
git switch -c sync/v0.7.5 main
git merge v0.7.5
# resolve, then run typecheck, lint, and the tests for the files you touched
git push -u origin sync/v0.7.5
gh pr create --base main
```

Merge conflicts that recur across syncs replay themselves once `rerere` is on. Set it once per
clone, with the three-way conflict style so you can see what the base looked like:

```bash
git config rerere.enabled true
git config merge.conflictstyle zdiff3
```

`.github/workflows/fork-upstream-drift.yml` dry-run merges `upstream/main` into `main` every
morning and fails with the conflicting file list. It also uploads the fork's whole delta against
upstream as an artifact, so a merge that quietly rewrites a fork feature shows up as a change in
the delta's shape. GitHub only runs scheduled workflows from the default branch, which is why
`main` has to stay the default.

Version lines never conflict on a sync, because the fork does not commit a version bump. The
next section explains why.

## Versions

The committed version in every `package.json` is upstream's, exactly. The fork's version exists
only in release tags: `v1.0.0`, `v1.0.1`, `v1.1.0-beta.1`. The tag parser in
`scripts/release-version-utils.mjs` accepts stable versions and `-beta.N` prereleases and
rejects any other prerelease identifier.

`scripts/fork/stamp-version.mjs <version>` writes that version into the root and every
workspace without committing. The release workflow runs it before building, and
`scripts/fork/build-desktop.sh <version>` runs it for a local build and restores the files
afterwards.

Why every workspace and not just desktop: the desktop app restarts a desktop-managed daemon
whenever the app version differs from the daemon's, and the daemon reports the version from
`packages/server/package.json` (`shouldRestartForVersion` in
`packages/desktop/src/daemon/daemon-manager.ts`). A build where desktop says 1.0.1 and the
server says 0.7.2 restarts its own daemon on every launch.

Why the fork's version has to differ from upstream's at all: the same guard is what stops a
fork app from adopting a leftover upstream desktop-managed daemon, which does not advertise
the `projectGroups` capability and would show a sidebar with no groups and no error. The guard
returns `false` whenever `desktopManaged` is false, so a daemon started by the CLI or launchd is
adopted at any version. The version protects you from a leftover desktop-managed daemon, not
from one you started yourself.

The 1.x line collides with upstream the day upstream ships 1.0.0. Nothing breaks on that day,
because the feed only ever compares fork builds with fork builds, but pick a new line before
then.

## The update feed

`packages/desktop/electron-builder.yml` publishes to `owner: totally-tim`. On upstream's feed,
the auto-updater (`autoDownload = true`, `allowDowngrade = false` in
`packages/desktop/src/features/auto-updater.ts`) would install an upstream release over the fork
build and take every fork feature with it. Check any built app: `Contents/Resources/app-update.yml`
must say `owner: totally-tim`.

## Releasing

Tag `main` and push the tag. `.github/workflows/desktop-release.yml` builds, notarizes, and
publishes to the repository it runs in, which is where the feed points, so installed fork apps
update themselves from that release.

```bash
git switch main && git pull
git tag v1.0.1
git push origin v1.0.1
```

The five notarization secrets (`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`,
`APPLE_PASSWORD`, `APPLE_TEAM_ID`) are set on the fork repository. `electron-builder.yml` sets
`notarize: true`, so nothing else is needed. The fork is a public repository, so a tagged release
is downloadable by anyone who finds it.

## Building and installing locally

```bash
scripts/fork/build-desktop.sh 1.0.1
```

The artifacts land in `packages/desktop/release/`. To install, quit Paseo first and wait for port
6767 to go quiet. The desktop settings ship `daemon.keepRunningAfterQuit: false`, so quitting
stops the daemon and kills every agent it manages. Remove the existing `/Applications/Paseo.app`
before copying the new one in, because of the shared settings profile below.

Confirm the swap took: `paseo daemon status` reports the fork version for both `CLI` and
`Daemon Version`. The CLI shim at `~/.local/bin/paseo` resolves into the installed app bundle.

A locally built app carries no quarantine flag and launches even though `spctl` rejects it as
"Unnotarized Developer ID". A teammate who downloads a DMG in a browser gets the quarantine flag
and is blocked. Only a CI release is notarized.

## Never open the upstream app again

Both builds use `appId: sh.paseo.desktop`, so they share one Electron settings profile at
`~/Library/Application Support/Paseo/`. That makes the fork a one-way door, in two places.

**The sidebar order is destroyed.** The persisted sidebar state is a `z.strictObject`, and the
fork adds a `projectGroupOrder` key to it (`packages/app/src/stores/sidebar-order-store.ts`).
`partialize` writes that key on every save, even as an empty array. Upstream's schema rejects
the unknown key, and `createValidatedPersistStorage` answers a failed parse with
`removeItem(name)` (`packages/app/src/storage/validated-persist-storage.ts`). That deletes the
whole entry, so your project order and your pinned workspaces go with the group order.

**The group assignments are stripped.** The daemon's persisted project record is a plain
`z.object`, so an upstream daemon drops the unknown `group` field from every project the next
time it writes `projects.json`.

Neither failure announces itself. If you need to go back to upstream, restore
`~/Library/Application Support/Paseo/` and `$PASEO_HOME/projects/` from a backup you took
before installing the fork.

The same trap applies to testing. To see how the fork app behaves against an upstream daemon,
point that upstream daemon at a **copied** `PASEO_HOME` on a non-default port. Never at the
real one.

## What the fork does not change

The `projectGroups` capability gate is tagged `COMPAT(projectGroups)` in
`packages/protocol/src/messages.ts` and `packages/server/src/server/websocket-server.ts`. Its
user-facing string is "Update the host to use groups", which is misleading on a fork, because
updating sends someone to upstream where the feature does not exist. That is left alone on
purpose: changing it means editing nine locale files that upstream churns constantly, in
exchange for a string that only appears when a fork app talks to an upstream daemon.

The README is upstream's. It still describes the product correctly, upstream edits it about
monthly, and a rewritten README is a conflict on every sync. The notice at the top is the only
fork edit.
