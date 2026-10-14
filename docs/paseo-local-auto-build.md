# Paseo Local automatic builds

Use the macOS LaunchAgent to rebuild `Paseo Local.app` after `origin/paseo-local` advances. It owns a stable checkout under `~/Library/Application Support/Paseo Local Builder/checkout` and updates that checkout with `git merge --ff-only`. It never checks out or fetches another branch.

Each run fetches the exact `paseo-local` ref, acquires a process lock, fast-forwards the clean checkout, and compares the remote commit with `last-successful-commit`. A changed commit runs `npm ci` followed by `npm run build`. The success marker is replaced atomically only after the build installs the app, so a failed build is retried at the next interval.

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
