# Paseo Local automatic builds

Choose the builder below when each Mac should compile `origin/main`. Use the [iCloud mirror](#icloud-mirror) when one Mac should distribute its installed build to another Apple Silicon Mac.

Use the macOS LaunchAgent to rebuild `Paseo Local.app` after `origin/main` advances. It owns a stable checkout under `~/Library/Application Support/Paseo Local Builder/checkout` and updates that checkout with `git merge --ff-only`. It never checks out or fetches another branch.

Each run fetches the exact `main` ref, acquires a process lock, fast-forwards the clean checkout, audits the declared development repositories, and compares the remote commit with `last-successful-commit`. A changed commit runs `npm ci` followed by `npm run build`. The success marker is replaced atomically only after the build installs the app, so a failed build is retried at the next interval.

The job never restarts the daemon. Update the daemon separately when interrupting its agents is
authorized. App installation and interface activation follow the [local release contract](development.md#local-macos-app).
`last-built-commit` identifies the packaged commit, `last-successful-commit` the installed commit,
and `last-active-commit` the commit confirmed by the running desktop and its windows. An installed
app remains pending activation until that confirmation arrives.

After each successful build, the job also archives `plugins/paseo-workflow` from that exact commit
under `workflow-releases/<commit>`. When the configured `paseo-workflow` plugin is enabled and the
daemon is running, it points the configured source path at that snapshot and reloads only that
plugin. The first conversion keeps the existing directory as
`~/.paseo/plugins/paseo-workflow-local.before-workflow-releases`; configuration and plugin settings
stay in place. If the daemon is stopped, the snapshot is ready and activation remains pending.
Failed reloads restore the previous source and retry on the next run.

The job does not open or close Paseo Local. The running desktop activates a newer installation
at idle after checkpointing its windows. The first installation of that mechanism requires one
manual interface relaunch.

## Complete-source gate

Run the installer from the development repository. It records the stable primary checkout in
`source-repositories.json` under the builder state directory, retaining previously declared
repositories. Use `PASEO_LOCAL_BUILDER_SOURCE` when installing from elsewhere. Do not register only
the dedicated builder clone: it cannot see work left on local branches or in linked checkouts.

The `main` pre-push hook, build wrapper, automatic builder, and final installer check that
all declared local branches, origin tracking refs, detached worktree heads, and non-ignored working
files are included in the candidate. Missing repositories or configuration block delivery too.
Integrate or preserve and explicitly resolve unfinished work; do not reset or delete it to pass.
The final installer repeats the audit after package tests because work may change during a build.

Read `source-audit.json` for the blocking refs and files. The desktop displays a blocked-publication
notice when that report contains failures. A later successful audit clears it. Install the Git hooks
with `npm run prepare` in development repositories; the builder gate remains required even when a
push came from a checkout with older hooks.

Treat development, publication, installation, and activation as separate states. A correction
ends with validated local code by default; it does not require a commit, publication, or rebuild.
Publish or deliver only when the request or approved plan includes it. For publication, integrate
into `main` within the given authorizations; the builder continues to follow `origin/main`.
Without a full-delivery request, do not routinely monitor installation or activation.

An explicit Mac rebuild request requires complete sources, publication, installation of the latest
published version, and separate verification of the active UI and main daemon build identities and
relevant capabilities. Build from `main` and record the remote commit, installed manifest, and both
active identities before marking the rebuild complete. That request authorizes the required main
daemon restart; warn Sylvain first because it can interrupt agents and the conversation.
The automatic builder itself never restarts the daemon. Preserve existing work and do not delete
`paseo-local` without Sylvain’s explicit approval.

## Existing builder migration

Suspend `sh.paseo.local-auto-build` and wait for any build holding `build.lock` to finish before
changing an existing clone. Keep the state directory, markers, source inventory, and configuration.
After the migration PR is merged, update the dedicated clone explicitly:

```bash
cd "$HOME/Library/Application Support/Paseo Local Builder/checkout"
git remote set-branches origin main
git fetch origin refs/heads/main:refs/remotes/origin/main
git switch -c main --track origin/main
git remote set-head origin main
```

Run `npm run paseo-local:auto-build:install` from the development repository to reinstall the job.
The installer refuses an existing clone on any other branch; it never migrates one implicitly.
Keep the old branch and backup tag until publication, installation, and desktop activation agree.
Remove `paseo-local` only after Sylvain explicitly approves its deletion.

## Commands

```bash
npm run paseo-local:auto-build:install
npm run paseo-local:auto-build:uninstall
npm run paseo-local:auto-build:verify-launchd
node scripts/paseo-local-auto-build.mjs sync-workflow
```

`sync-workflow` uses only `last-successful-commit`. It does not fetch, build, or restart the daemon,
so use it to repair the active plugin after an already successful build. It records activation only
after the targeted reload reports `running`.

Installation is idempotent and loads `~/Library/LaunchAgents/sh.paseo.local-auto-build.plist`. Uninstallation unloads the job and removes the plist. It keeps the checkout, success marker, and log for a fast reinstall and diagnosis.

Install after this automation has reached `origin/main`. The installer refuses to load a job when the remote checkout does not contain its runtime script.

The LaunchAgent runs at login and every five minutes. Read the log with:

```bash
tail -f "$HOME/Library/Logs/Paseo Local Builder.log"
```

`verify-launchd` loads a temporary LaunchAgent that writes a probe file, then unloads and removes it. The probe uses the real `launchctl` path without building the app or connecting to the daemon.

## iCloud mirror

Enable iCloud Drive on both Macs with the same Apple Account. On the Mac that builds Paseo Local, run:

```bash
npm run paseo-local:icloud:enable
```

This publishes the installed `~/Applications/Paseo Local.app` and installs a LaunchAgent that checks for changed builds every five minutes and at login. It observes the installed bundle produced by the gated release circuit. To publish immediately after a build, run `npm run paseo-local:icloud:publish`.

On the receiving Mac, open **iCloud Drive → Paseo Local → Install on MacBook.command** in Terminal once. The installer copies itself outside iCloud and installs a LaunchAgent; Node, npm, and a repository checkout are not required. The receiver checks every five minutes and at login. Uninstall its local auto-builder first if one is installed: both jobs must not replace the same app.

The transfer uses immutable ZIP archives and a SHA-256 manifest. iCloud can download these files in either order; the receiver waits for missing files and rejects incomplete downloads. Before replacing the app, it verifies the checksum, bundle identifier, and macOS signature. Installation waits while a process runs from the installed app, including its bundled daemon. Neither job closes the app or restarts the daemon.

The source app keeps its existing signing and notarization status. This mirror does not notarize local builds or bypass macOS launch checks. It transfers only the app: host configuration, conversations, credentials, and external plugins stay on each Mac.

Read the logs in `~/Library/Logs/sh.paseo.local-icloud-publisher.log` on the source Mac and `~/Library/Logs/sh.paseo.local-icloud-mirror.log` on the receiver. Archive retention is manual: keep the ZIP named by `latest.sha256`; older ZIPs can be removed when you no longer need them. iCloud transfer latency determines when a build becomes available.

Disable publication with `npm run paseo-local:icloud:disable`. On the receiver, uninstall with:

```bash
/bin/zsh "$HOME/Library/Application Support/Paseo Local Mirror/mirror.command" uninstall
```

Both commands keep the installed app and shared archives. The publisher creates the shared installer
once and leaves it in place: macOS can deny LaunchAgents access to an existing iCloud `.command`
file. New app archives do not require a new installer. To update the receiver script itself, replace
the shared installer manually from the current `scripts/paseo-local-icloud.command`, then run it on
the receiver. Rerun the enable command on the source to update its publisher runtime.

Publication to iCloud proves only that the archive and checksum are available on the source Mac.
Confirm installation and the active build on the receiving Mac separately.
