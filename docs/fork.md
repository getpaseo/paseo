# The team fork

This repository is a permanent fork. `totally-tim/paseo` carries one feature that upstream
`getpaseo/paseo` will not take, and three configuration commits that stop the fork from
quietly turning back into upstream. Read this before you build a desktop app, cut a release,
or wonder why the version says 1.x.

## What the fork adds

One feature: **project groups in the sidebar**. You create a named group, assign projects to
it, and the sidebar renders a collapsible header with those projects nested under it. The
daemon persists the assignment as a `group` field on each project record in
`$PASEO_HOME/projects/projects.json`. The group's display order is client-side, in the app's
sidebar order store.

The work is about 6300 lines across roughly 110 files, sitting on branch `team-main`.

## Why it is a fork and not a pull request

Upstream PR [#4246](https://github.com/getpaseo/paseo/pull/4246) is open as a draft and is not
expected to merge. The maintainer has said he wants outside contributions to be about the SDK
and plugin extensions rather than changes to the core app.

**It cannot be a plugin.** The plugin API contributes native surfaces, sidebar items, workspace
panels, Command Center items, slash commands, composer pills, attachment sources, timeline
items, themes and RPCs — see `docs/plugins.md` and `public-docs/plugins/v0.8/reference.md` for
the authoritative list. None of those reach the sidebar's project list, the workspace
descriptor, or the persisted project record, which is where grouping has to live.

**This is settled.** Do not reopen whether to make it a plugin, and do not re-submit the PR.

## The three commits that protect the fork

Each one exists to stop a specific way the fork erases itself. Do not revert them.

**`47b2c043b` repoints the update feed.** `packages/desktop/electron-builder.yml` publishes to
`owner: totally-tim`. Left on upstream's feed, the auto-updater — which runs with
`autoDownload = true` and `allowDowngrade = false` (`packages/desktop/src/features/auto-updater.ts`)
— would install an upstream release over the fork build and take the feature with it. You can
check any built app: `Contents/Resources/app-update.yml` must say `owner: totally-tim`.

**`17fc9b08d` moves the fork to the 1.x line.** The desktop app adopts a daemon that is already
listening on the port rather than starting its own, and `shouldRestartForVersion` in
`packages/desktop/src/daemon/daemon-manager.ts` only forces a restart when the version strings
differ. At a shared 0.7.2 the fork app would adopt an upstream daemon, which does not advertise
the `projectGroups` capability, and the sidebar would show no groups with no error to explain it.

That guard is narrower than it looks. `shouldRestartForVersion` returns `false` whenever
`current.desktopManaged` is false, so a daemon started by the CLI or by launchd gets adopted at
**any** version. The version bump protects you from a leftover desktop-managed daemon, not from
one you started yourself.

**`9b06c2724` adds the nightly drift check.** `.github/workflows/fork-upstream-drift.yml`
dry-run merges upstream `main` into `team-main` every morning and fails with the conflicting
file list. It also keeps the fork delta as an artifact, so a merge that quietly rewrites the
feature shows up as a change in the delta's shape. Let that workflow tell you when to merge
upstream; do not merge upstream ad hoc as part of unrelated work.

## Never open the upstream app again

Both builds use `appId: sh.paseo.desktop`, so they share one Electron settings profile at
`~/Library/Application Support/Paseo/`. That makes the fork a one-way door, in two places.

**The sidebar order is destroyed.** The persisted sidebar state is a `z.strictObject`, and the
fork adds a `projectGroupOrder` key to it (`packages/app/src/stores/sidebar-order-store.ts`).
`partialize` writes that key on every save, even as an empty array, so the first sidebar write
from the fork app is enough. Upstream's schema rejects the unknown key, and
`createValidatedPersistStorage` answers a failed parse with `removeItem(name)`
(`packages/app/src/storage/validated-persist-storage.ts`). That deletes the whole entry, so
your project order and your pinned workspaces go with the group order.

**The group assignments are stripped.** The daemon's persisted project record is a plain
`z.object`, so an upstream daemon drops the unknown `group` field from every project the next
time it writes `projects.json`.

Neither failure announces itself. If you need to go back to upstream, restore
`~/Library/Application Support/Paseo/` and `$PASEO_HOME/projects/` from a backup you took
before installing the fork.

The same trap applies to testing. If you want to see how the fork app behaves against an
upstream daemon — the `projectGroups` capability gate hiding the grouping UI — point that
upstream daemon at a **copied** `PASEO_HOME` on a non-default port. Never at the real one.

## Building and installing the desktop app

```bash
PASEO_DESKTOP_SMOKE=1 npm run build:desktop -- --mac --arm64 -c.mac.notarize=false
```

The artifacts land in `packages/desktop/release/`. To install, quit Paseo first and wait for
port 6767 to go quiet — the desktop settings ship `daemon.keepRunningAfterQuit: false`, so
quitting stops the daemon and kills every agent it manages. Then remove the existing
`/Applications/Paseo.app` before copying the new one in, because of the shared settings
profile above.

Confirm the swap took: `paseo daemon status` should report the fork version for both `CLI` and
`Daemon Version`. The CLI shim at `~/.local/bin/paseo` resolves into the installed app bundle,
so it follows whatever is in `/Applications`.

A locally built app carries no quarantine flag and launches fine even though `spctl` rejects it
as "Unnotarized Developer ID". A teammate who downloads a DMG in a browser gets the quarantine
flag and is blocked. Notarization in CI is what fixes that.

## Releases and notarization

`.github/workflows/desktop-release.yml` triggers on `v*` tags and publishes to whatever
repository it runs in, so on the fork it publishes to the fork — which is also where the
update feed points, so a tagged release is how installed fork apps update themselves.

`packages/desktop/electron-builder.yml` already sets `notarize: true`, so the mac build
notarizes as soon as five repository secrets exist. No workflow edit is needed.

| Secret                       | Value                                                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `APPLE_CERTIFICATE`          | Developer ID Application certificate as a base64 `.p12`, with its private key and the Developer ID intermediate |
| `APPLE_CERTIFICATE_PASSWORD` | The passphrase on that `.p12`                                                                                   |
| `APPLE_ID`                   | The Apple ID email on the developer account                                                                     |
| `APPLE_PASSWORD`             | An app-specific password from appleid.apple.com, not the account password                                       |
| `APPLE_TEAM_ID`              | The team ID, which also appears in `codesign -dv` output as `TeamIdentifier`                                    |

The fork is a public repository, so a tagged release is downloadable by anyone who finds it.

## What the fork does not change

The `projectGroups` capability gate is tagged `COMPAT(projectGroups)` in
`packages/protocol/src/messages.ts` and `packages/server/src/server/websocket-server.ts`. Its
user-facing string is "Update the host to use groups", which is misleading on a fork, because
updating sends someone to upstream where the feature does not exist. That is left alone on
purpose: changing it means editing nine locale files that upstream churns constantly, in
exchange for a string that only appears when a fork app talks to an upstream daemon.
