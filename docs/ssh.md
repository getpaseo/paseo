# SSH remote hosts

Connecting to a Paseo daemon on another machine over SSH, from the CLI
(`--host ssh://user@host`) or the desktop app's **Add connection → SSH**.

Paseo opens one SSH connection that does three things at once: authenticates,
makes sure a daemon is running on the far side, and forwards the daemon's port
to a local one. The WebSocket client then connects to `127.0.0.1:<localPort>`
as if the daemon were local.

## Why one connection

An earlier design used two connections — one to run the ensure step, one for
the port forward — multiplexed with `ControlMaster`. That meant two
authentications (two password prompts) and a dependency on a control socket
that behaves differently across OpenSSH versions.

Instead, the SSH connection's remote command is `exec /bin/sh` while `-L`
forwards the port, and the ensure script is piped to that shell over stdin.

**The remote command is not the script, and that is deliberate.** sshd runs a
remote command as `<user's shell> -c "<command>"`, taking the shell from the
password database — see `session.c`, which sets `argv[0]=shell0; argv[1]="-c";
argv[2]=command`. It is not a _login_ shell (no `-l`, argv[0] is not
dash-prefixed, so `~/.bash_profile` is not sourced), but it **is** the user's
shell binary. On a host where someone has `chsh`'d to fish or tcsh, our POSIX
script would be handed to fish or tcsh and fail outright.

Wrapping it as `/bin/sh -c '<script>'` does not help: that outer string still
goes through the user's shell, and neither fish nor csh can carry the single
quotes and embedded newlines the script contains. Reducing the command to three
metacharacter-free words is what makes it shell-agnostic — every shell agrees
on what `exec /bin/sh` means.

Two things fall out of this for free: nothing needs shell-escaping on the way
in, and the script no longer appears in the remote host's process list, where
any other user could read it.

Consequences for the script itself:

- **The keepalive is the absence of an exit.** `sh` reading a script from a
  pipe executes incrementally and blocks for the next line, so falling off the
  end holds the connection open. No `cat`, and no `sleep infinity` — BusyBox
  and older BSD `sleep` reject `infinity`. Closing stdin is the teardown.
- **The exit code has to be preserved by hand.** `ensure_daemon && ...`
  collapses every failure to exit 1 and loses the reason. The script ends with
  `ensure_daemon; rc=$?; [ $rc -eq 0 ] || exit $rc`.
- **Children must not read stdin.** The script is _on_ stdin, so anything that
  reads it would swallow the remainder. `npm install` and the daemon launch
  both get `</dev/null`.

## Readiness: `READY:` not prose

The local port forward accepts connections the moment SSH connects — before the
remote daemon is listening. Waiting on the local port is therefore a false
positive, and the tunnel would hand a dead socket to the client.

Readiness comes from the ensure script writing a `READY:` line to stderr.

`PROGRESS:` and `READY:` are deliberately separate markers:

- `PROGRESS:<text>` is human-facing status. Reword it freely.
- `READY:<reason>` is the machine contract. Changing it breaks the tunnel.

Matching readiness against the text of a progress message — which an earlier
version did — means rewording a status string silently turns into a five-minute
hang.

## Which `paseo` runs on the remote host

In order:

1. **Something already listening on the daemon port** → use it, touch nothing.
2. **`paseo` on `PATH`** (global npm, system package manager, nix) → launch it.
3. **Neither** → install into `installDir` (`~/.paseo/cli` by default) and
   launch that.

Step 2 exists for correctness, not disk space. If Paseo installed its own copy
alongside a system install, a user on the remote host could start _their_
daemon from the system binary while we run a different build against the same
`PASEO_HOME` — two daemons fighting over the port and the agent state.

**Paseo only ever installs or upgrades inside `installDir`.** A binary it did
not put there is never touched, upgraded, or replaced.

### Versions

The CLI pins the remote install to its own version so both ends run the same
build, and re-installs when the managed copy drifts. Two consequences:

- A source checkout or unpublished beta has no registry entry. The script
  detects the failed install and retries with `@latest` rather than hard
  failing, so connecting from a dev build works.
- Version pinning only applies to the managed copy. A `PATH` install is used
  as-is at whatever version it happens to be, and an already-running daemon is
  never restarted to change its version. Capability mismatches there are the
  job of `server_info.features.*`, not of this script.

## Exit codes

The script's exit codes are the contract with `describeEnsureFailure`:

| Code | Meaning                                          |
| ---- | ------------------------------------------------ |
| 0    | Daemon ready                                     |
| 10   | Node.js missing                                  |
| 11   | Install failed                                   |
| 12   | Never listened                                   |
| 13   | npm missing                                      |
| 255  | SSH itself failed (auth, DNS, host key, refused) |

Anything else falls through to `describeSshFailure`, which surfaces SSH's own
stderr. Retaining that stderr takes deliberate effort: attaching a `data`
listener to parse progress markers puts the stream in flowing mode, so a later
`stream.read()` returns nothing. `readSshStderr` buffers as it parses,
otherwise every failure reports an empty reason.

## Shell requirements

The remote host needs `/bin/sh` and nothing else — the user's own shell can be
fish, tcsh, or anything at all, because it only ever sees `exec /bin/sh` (see
"Why one connection" above).

Every interpolated value (hostnames, paths, version specs) is still
single-quoted through `shellQuote`, so paths with spaces, quotes, or `$` work
and cannot inject. That is defense in depth rather than the primary boundary
now, but the script is still assembled as text and the quoting has to be right.

`~`-relative paths are rendered as `"$HOME"/'rest/of/path'`: the tilde expands,
the remainder cannot be reinterpreted.

## Ports and `~/.ssh/config`

`SshHostConfig.port` is deliberately **not** defaulted to 22, and the protocol
schema leaves it optional without a default. "Unset" has to stay
distinguishable from "22" — passing `-p 22` unconditionally would override a
`Port` directive the user configured for that host. Everything else in their
SSH config (`IdentityFile`, `ProxyJump`, `User`) applies as usual.

The Add SSH Host modal leaves the port field blank with a `22` placeholder for
the same reason.

## Password prompts

SSH only takes a secret from a program's stdout, and only asks through
`SSH_ASKPASS` when there is no tty. So there is always a small askpass program
— but what it does differs between the two clients.

**Desktop** uses `createAskpassChannel`. Paseo starts a unix socket in a
private `mkdtemp` directory and writes two files next to it: a POSIX shell
wrapper (the thing SSH executes) and a Node helper that relays. The prompt
travels to the main process, which asks the renderer, and the answer comes back
down the socket to the helper's stdout.

That means the dialog is Paseo's own — styled, localized, and able to say
whether it wants a key passphrase or an account password. It replaces shelling
out to `zenity` / `kdialog` / `osascript`, which cost us an unstyled dialog we
could not control and a pile of GTK-specific escaping (underscores read as
mnemonic accelerators, Pango markup parsing).

Two details worth keeping:

- **The helper is written at runtime, not shipped.** Nothing has to be resolved
  or unpacked from inside an asar archive.
- **The wrapper sets `ELECTRON_RUN_AS_NODE=1`.** Under the desktop app the
  runtime is the Electron binary in Node mode; the variable is inert for a
  plain `node`, so one wrapper shape serves the CLI too.

`SSH_ASKPASS` must be an executable path, which is why a plain socket is not
enough on its own — a POSIX shell cannot speak one. A FIFO pair would avoid the
helper entirely, but a dismissed prompt or a missing window leaves `cat`
blocked and SSH hanging; a socket fails fast instead and multiplexes
concurrent attempts naturally.

**CLI** keeps `createTerminalAskpassScript`, which prompts on `/dev/tty` and
suppresses echo with `stty -echo` — not `read -s`, a bash/zsh extension that
fails under dash, which is `/bin/sh` on Debian and Ubuntu.

### Cancelling

SSH gives askpass no way to report a cancellation: it discards the program's
exit status and simply retries up to `NumberOfPasswordPrompts`. A dismissed
dialog is therefore indistinguishable from a wrong password and comes straight
back.

The two clients solve that differently, because each knows something SSH does
not:

- **Desktop:** declining aborts `AskpassChannel.signal`, and `SshTunnel.open`
  kills the SSH process on abort and throws `SshCancelledError`.
- **CLI:** the terminal script writes `ASKPASS_CANCELLED_MARKER` to stderr,
  which is inherited by ssh (only stdout is redirected to the password pipe)
  and so lands in the stream the tunnel already parses.

Both abort on the first refusal. Note that SSH's default of three attempts is
deliberately left alone — a _typo_ should still be retryable, and only an
explicit refusal ends the attempt.

## Desktop: the Origin header

The renderer's `Origin` never matches the tunnel's ephemeral loopback port, so
the remote daemon's same-origin check rejects the upgrade and the socket closes
with 1006.

The fix strips `Origin` — but **only for ports the main process is currently
forwarding** (`sshTunnelPorts`). That check is the daemon's DNS-rebinding
defense (see [SECURITY.md](../SECURITY.md)); disabling it for all of loopback
would also disable it for a directly-connected local daemon. The rule is
installed once per session, since Electron allows a single
`onBeforeSendHeaders` listener per session and a per-window registration
silently replaces the previous one.

## Multiple hosts, multiple tunnels

Each saved host gets its own `HostRuntimeController`, and they all run at once
(`ensureConnectedAll`, `runProbeCycleNow` fan out over every controller). So N
connected SSH hosts means N `ssh` processes and N local port forwards.

The ports themselves need no coordination:

- Every tunnel takes a fresh ephemeral port from `findFreeLocalPort()`, which
  binds `:0` and lets the OS pick. Two tunnels cannot be handed the same port
  in practice, and `ExitOnForwardFailure=yes` turns the residual bind race into
  a loud failure rather than a silent misroute.
- The remote side is always `remotePort` (6767 by default) on a _different
  machine_, so it never collides across hosts.
- The desktop keys live tunnels by a UUID in `sshTunnels`, with `sshTunnelPorts`
  mapping id → local port for the Origin rule.

What does need managing is the _number_ of tunnels, and two things keep it
bounded:

**Probes never open a throwaway tunnel.** The probe cycle exists to time
connections so the adaptive switcher can pick the fastest. For a TCP endpoint
that is cheap. For SSH it means spawning `ssh`, authenticating, and running the
ensure script — every 120s, per host, re-prompting anything using password auth.
So a non-active SSH connection is simply not probed. It is only "probed" when it
is already the live client, where reading `getLastLivenessRttMs()` is free, or
when nothing is online and connecting is the point anyway.

The tradeoff: an SSH connection carries no latency number while another
transport is online, so `selectBestConnection` will never adaptively switch
_onto_ a tunnel on RTT alone. That is the behavior we want — silently migrating
a live session onto an SSH tunnel because loopback measured 2ms would be
surprising. Failover is unaffected: when the active connection drops,
`hasActiveOnlineConnection` goes false and SSH becomes eligible on the next
cycle.

**Every discarded client releases its transport.** See below.

## Tunnel ownership

An SSH-backed `DaemonClient` owns a tunnel the client itself knows nothing
about. `closeClientAndTransport` in `test-daemon-connection.ts` is the only
correct way to dispose one — a bare `client.close()` leaves the `ssh` process
and the port forward alive for the lifetime of the app.

The disposer lives in a `WeakMap` keyed by client rather than being threaded
through every intermediate signature between the probe and the eventual close.
Any one of those forgetting to pass it along is a leak that is invisible at the
call site.

## Daemons must outlive their session

`paseo daemon start` wraps the launch in `systemd-run --user --scope` where
available. Under systemd-logind with `KillUserProcesses=yes` a detached daemon
inherits the launching session's cgroup and dies with it — when an SSH
connection closes, when a desktop session logs out, or when the terminal that
started it exits. The transient scope escapes that, and `loginctl
enable-linger` keeps the user's systemd instance alive after the last session
closes.

This is not SSH-specific; it is a general property of detached daemons on
systemd, and the SSH flow just makes it obvious.

## Trust

- The remote daemon binds `127.0.0.1` and is only reachable through the tunnel.
  It is launched with `--no-relay --no-mcp`.
- Host keys use `StrictHostKeyChecking=accept-new`: first connection is
  trust-on-first-use, and a _changed_ key still fails. The desktop UI has no
  way to show a fingerprint for confirmation, so a first connection from the
  GUI accepts the key without showing it. Connect once from the CLI first if
  you want to verify a fingerprint by hand.
