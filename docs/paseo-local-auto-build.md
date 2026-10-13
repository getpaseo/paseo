# Paseo Local automatic builds

Choose the builder below when each Mac should compile `origin/paseo-local`. Use the [iCloud mirror](#icloud-mirror) when one Mac should distribute its installed build to another Apple Silicon Mac.

Use the macOS LaunchAgent to rebuild `Paseo Local.app` after `origin/paseo-local` advances. It owns a stable checkout under `~/Library/Application Support/Paseo Local Builder/checkout` and updates that checkout with `git merge --ff-only`. It never checks out or fetches another branch.

Each run fetches the exact `paseo-local` ref, acquires a process lock, fast-forwards the clean checkout, and compares the remote commit with `last-successful-commit`. A changed commit runs `npm ci` followed by `npm run build`. The success marker is replaced atomically only after the build installs the app, so a failed build is retried at the next interval.

After installation, the job restarts a running desktop-managed daemon from `~/.paseo` so its code
and plugins match the new app. A separate marker makes this happen once per built commit. A failed
restart is retried at the next interval without rebuilding the app. A stopped or independently
managed daemon is left untouched.

After each successful build, the job also archives `plugins/paseo-workflow` from that exact commit
under `workflow-releases/<commit>`. When the configured `paseo-workflow` plugin is enabled and the
daemon is running, it points the configured source path at that snapshot and reloads only that
plugin. The first conversion keeps the existing directory as
`~/.paseo/plugins/paseo-workflow-local.before-workflow-releases`; configuration and plugin settings
stay in place. If the daemon is stopped, the snapshot is ready and activation remains pending.
Failed reloads restore the previous source and retry on the next run.

The job does not open or close Paseo Local. Reopen the app to use the new renderer. The automatic
daemon restart interrupts provider processes and background work still resident in them.

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

Install after this automation has reached `origin/paseo-local`. The installer refuses to load a job when the remote checkout does not contain its runtime script.

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

This publishes the installed `~/Applications/Paseo Local.app` and installs a LaunchAgent that checks for changed builds every five minutes and at login. It observes the installed bundle, so builds from other checkouts and the automatic builder are included. To publish immediately after a build, run `npm run paseo-local:icloud:publish`.

On the receiving Mac, open **iCloud Drive → Paseo Local → Install on MacBook.command** in Terminal once. The installer copies itself outside iCloud and installs a LaunchAgent; Node, npm, and a repository checkout are not required. The receiver checks every five minutes and at login. Uninstall its local auto-builder first if one is installed: both jobs must not replace the same app.

The transfer uses immutable ZIP archives and a SHA-256 manifest. iCloud can download these files in either order; the receiver waits for missing files and rejects incomplete downloads. Before replacing the app, it verifies the checksum, bundle identifier, and macOS signature. Installation waits while a process runs from the installed app, including its bundled daemon. Neither job closes the app or restarts the daemon.

The source app keeps its existing signing and notarization status. This mirror does not notarize local builds or bypass macOS launch checks. It transfers only the app: host configuration, conversations, credentials, and external plugins stay on each Mac.

Read the logs in `~/Library/Logs/sh.paseo.local-icloud-publisher.log` on the source Mac and `~/Library/Logs/sh.paseo.local-icloud-mirror.log` on the receiver. Archive retention is manual: keep the ZIP named by `latest.sha256`; older ZIPs can be removed when you no longer need them. iCloud transfer latency determines when a build becomes available.

Disable publication with `npm run paseo-local:icloud:disable`. On the receiver, uninstall with:

```bash
/bin/zsh "$HOME/Library/Application Support/Paseo Local Mirror/mirror.command" uninstall
```

Both commands keep the installed app and shared archives. After changing the mirror script, rerun the enable command on the source and the shared installer on the receiver to update their local runtime copies.
