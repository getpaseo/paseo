# Terminal worker

Every terminal's PTY lives in the terminal worker, a process separate from the daemon. The worker outlives the daemon, so restarts, crashes and upgrades keep terminals running. This doc covers what the code can't tell you: why the process model is shaped this way, the rules nothing enforces, and the known limits.

## Process model

```
supervisor (paseo.pid) ──► daemon worker ──► launcher ──► terminal worker ──► PTY programs
                                                exits      (re-parented to init)
```

- The daemon starts the worker through a launcher (`terminal-worker-process.ts --launch`). The launcher spawns the worker `detached`, waits for `ready` on fd 3, prints the pid and exits, so the worker is re-parented and leaves the daemon's process tree. The supervisor's forced kill uses `tree-kill`, which walks parent pids: a worker that stayed a child, even detached, would die with a hung daemon.
- The worker talks to one daemon at a time over a local socket (named pipe on Windows). Losing the daemon means "no controller", not exit: PTYs keep running, events are dropped, and the headless terminal keeps the screen for the next daemon's `listTerminals`.
- A socket disconnect triggers reconnection to the same worker and a screen replay. Only confirmed process death retires its sessions; the next terminal creation shares one replacement launch. Dead-worker cleanup stays scoped to that worker, so a healthy draining peer keeps running. Shutdown and detach suppress recovery.
- The worker exits on its own when it has no controller and no terminals, on `shutdown`, on SIGTERM (killing its terminals), and when its record disappears (a deleted `$PASEO_HOME`: nobody can ever reach it again).
- Its stderr goes to `$PASEO_HOME/terminal-worker.log`. No pipe to the daemon survives the daemon.

Which triggers keep terminals and which close them is owned by the stop reason (`keepTerminals`) that flows from the request through the supervisor to `stop()`. The kill side always ends in the reaper (`terminal-worker-reaper.ts`), the only path that signals terminal processes outside a connected daemon.

## Record, socket and secret

The worker writes `$PASEO_HOME/terminal-worker/<pid>.json` (owner-only) with its identity (birth time + command line carrying `--paseo-terminal-worker <recordId>`), protocol version, socket path, a random secret, the copy it runs from, and each terminal program's pid and birth time.

- The first frame on the socket must be `hello` with the secret; anything else closes the connection. Anyone who connects can type into every shell, so the record is `0600`, the unix socket `0600` in a `0700` directory.
- Unix socket paths have a byte budget (103 on macOS, 107 on Linux). Dev homes under worktrees blow it, so `terminal-worker-socket-path.ts` tries `$PASEO_HOME/terminal-worker/sock/`, then `$TMPDIR/paseo-<uid>/`, then `/tmp/paseo-<uid>/`, and accepts an existing directory only if it is a real `0700` directory owned by you. It never chmods a shared root.
- Cleanup signals a process only when its birth time matches the record. Birth times come from `ps -o lstart` with `LC_ALL=C` (it follows `LC_TIME` otherwise) and from `Win32_Process.CreationDate`. A missing birth time is "unknown", never matched by command text: a shell that ran `exec` keeps its pid and birth time but not its argv.
- A kill cleanup that cannot confirm every process gone writes `closing-<recordId>.json` beside the worker record. The worker rewrites its own record whenever a terminal starts or exits, so the kill intent has to live in a file it never writes. A closing record is never adopted; the next stop or start retries it.
- An unreadable record of either kind makes `daemon status` and a kill restart fail with its path: a kill cleanup that met it could not check what it names, and leaves nothing else behind. A read that fails with `EPERM`, `EBUSY` or `EACCES` is retried for 250ms first: on Windows, opening a record while the worker renames its new copy over it fails that way for a moment.

## Protocol versions

`TERMINAL_WORKER_PROTOCOL_VERSION` (`terminal-worker-protocol.ts`) is bumped whenever a request, response or event changes shape. A daemon classifies each live worker at start:

| Worker reports                     | Daemon does                                                                                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| its own version                    | adopts it                                                                                                                                                   |
| one version older                  | adopts it to drain: it keeps its terminals, takes no new ones, and is let go after its last terminal exits                                                  |
| two or more older                  | shuts it down; its terminals close (logged)                                                                                                                 |
| newer, or a version it cannot read | leaves it running, undriven; `list_terminals` and `create_terminal` answer `rpc_error` `terminal_worker_incompatible`, and `paseo daemon status` prints why |

Never more than two workers run. A new worker launches only when none is current, none is incompatible and fewer than two run. The count comes from the records, so an unreachable or unidentified worker counts, and so does one a cleanup could not confirm gone. When two run, the daemon starts with no current worker, and the first terminal created after one of them exits launches it.

**The frozen envelope never changes across versions:** the frame format (4-byte length + `v8.serialize`), `hello`/`helloAck`, the `listTerminals` info fields and `shutdown`. That is what lets any daemon close any worker: a kill stop sends `shutdown` to a newer worker it cannot otherwise drive. When you bump the version, keep a previous-version adapter so the draining worker can still be driven, and drop the adapter for the version before that.

Tests stand up other versions with `PASEO_TERMINAL_WORKER_PROTOCOL_OVERRIDE`, read by the worker. It is test-only.

## Running from its own copy

A worker outlives the installation that started it. An npm or desktop update replaces that installation's files, and the next terminal the old worker creates would load node-pty's `spawn-helper` and the zsh integration from paths that no longer exist. So a built daemon does not launch the worker from its install:

- `npm run build` bundles the worker with esbuild (`packages/server/scripts/build-terminal-worker.mjs`) into `dist/server/terminal-worker/` with its `shell-integration/` beside it. Only node-pty stays external. A package loaded through a module-local `createRequire` is invisible to esbuild and would be missing at run time; `terminal-worker-runtime.test.ts` fails if the bundle loads anything but built-ins and node-pty.
- Before launching, the daemon copies the bundle, the shell integration and node-pty (this platform's native build only) into `$PASEO_HOME/terminal-worker/<paseoVersion>-<hash>/` and launches from there. The hash covers the bundle and node-pty, so a local rebuild of the same version gets its own copy.
- A copy is deleted once no record names it: after a draining worker exits, after a kill cleanup, and at daemon start. The daemon and the reaper delete copies, never the worker itself, so a worker exiting cannot remove a copy a new worker is about to launch from.
- Dev (`.ts` source) launches from source and copies nothing.

Each create carries the controlling daemon's environment and Paseo CLI path (`baseEnv`, `paseoCliPath`), so a terminal opened after an upgrade gets the new installation's `PASEO_CLI` while older terminals keep theirs.

## Desktop

Desktop app updates and version-mismatch restarts stop the daemon with "keep terminals" on macOS and Linux, through `daemon stop --keep-terminals` (the shutdown RPC; SIGTERM always means "stop and close"). A daemon that predates the feature cannot keep terminals: the CLI refuses before sending anything, and desktop logs that and stops it with its terminals closed.

On Windows every desktop stop closes terminals. In the desktop app the worker runs as `Paseo.exe` with `ELECTRON_RUN_AS_NODE`, and a surviving one would lock the install folder the NSIS update replaces. Restarts, crashes and npm self-updates keep terminals on Windows too.

## Known limits

- On macOS `ps` has no session id, so a HUP-ignoring child of a shell that had already exited before cleanup started (re-parented to launchd) is not found. Linux reaches it through the session; a program that `exec`s keeps its entry on every OS.
- On Linux, a member of a gone shell's session is signaled only if its environment carries that terminal's `PASEO_TERMINAL_ID`. A job that scrubbed its environment (`env -i`) is reported as unconfirmed, with its pid, and never signaled.
- The agent-hook activity URL is baked into each shell when it starts. If the daemon's listen address changes across a restart, older shells report to the old address.
- Restoring terminals after a reboot is out of scope: records from an earlier boot are retired without signaling anything.
