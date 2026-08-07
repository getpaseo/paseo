# Terminal input readiness

Paseo runs `paseo.json` scripts and worktree bootstrap commands by **typing them
into a real terminal** — `spawnWorkspaceScript` and `runWorktreeTerminalBootstrap`
create a PTY running the user's interactive shell and send `<command>\r` as input.
That is deliberate: the command gets the user's real shell environment, aliases and
functions, the output lands in a terminal the user can read and Ctrl-C, and the
shell (not us) parses the command line.

The catch: **input is a shared channel.** Whatever is reading stdin at that moment
receives the keystrokes. If shell startup is blocked on `read`, it — not the line
editor — eats them.

## The bug this exists to prevent

oh-my-zsh prints `[oh-my-zsh] Would you like to update? [Y/n]` during startup and
blocks on `read -k 1`. Paseo's old readiness check resolved as soon as the terminal
produced **any output**, so it typed the command into that prompt. The `read` ate
the first character and the rest replayed onto the shell line:

```
PASEO_DEV_MANAGED_HOME=1 … npm run dev     ← what we sent
ASEO_DEV_MANAGED_HOME=1 … npm run dev      ← what ran (the P answered the prompt)
```

A silently wrong env var. Had the first character been `y`, it would have answered
"yes, update oh-my-zsh" instead.

## The invariant

**Only type when the shell's line editor owns stdin.** Three properties make that
checkable:

1. **At-prompt is current state, not history.** `getPromptState().atPrompt` is true
   only while ZLE holds the line. It goes false on OSC `633;C` (a command took the
   foreground) and on shell exit. "It printed a prompt once" is not evidence that
   stdin is free now — which is also what makes reusing a script terminal safe.
2. **Every marker is nonce-tagged.** Each terminal gets a `PASEO_TERMINAL_NONCE` in
   its env; the shell echoes it back in each marker. Stray OSC 633 traffic (VS Code's
   own shell integration emits the same codes) and replayed scrollback cannot fake
   terminal state. This is a collision guard, not a security boundary — anything that
   can read the env can type into the PTY anyway.
3. **The shell announces whether it can report readiness at all.** Without this,
   silence is ambiguous, and that ambiguity is the whole problem: see below.

## Silence is ambiguous — the announce resolves it

A shell that never sends a readiness marker is either **blocked** (integration loaded,
startup waiting on input — must not type) or **mute** (no integration, no marker is
ever coming — must type, or the feature is dead for that user). Both look identical.

Guessing from the shell's filename is not enough: `basename === "zsh"` says we
_installed_ the integration, not that it _works_. zsh older than 5.3 has no
`add-zle-hook-widget`, and a `.zshrc` can clobber `ZDOTDIR` or our hooks. Treating
those as "blocked" fails every script with a 15s timeout for users whose shells worked
fine before.

So the shell says so itself, with OSC `633;I;<nonce>`, emitted from the **first lines
of the `.zshenv` wrapper** — before the user's `.zshenv`, before `.zshrc`, before
oh-my-zsh, before anything that can block on `read`. Placement is the entire point:

| Signal                   | Meaning                               | Daemon                          |
| ------------------------ | ------------------------------------- | ------------------------------- |
| announce, then `R`       | integration live, editor has the line | type                            |
| announce, no `R`         | integration live, startup is blocked  | never type; wait, then fail     |
| no announce within grace | no integration here                   | legacy heuristic (old behavior) |

The wrapper only announces when it can deliver: it checks `is-at-least 5.3`. Announcing
without delivering would strand every script on the timeout.

The grace is 5s, and expiring is not on its own enough to fall back: the daemon
re-reads the state **from the worker** first (`fetchPromptState`). The parent holds a
copy that lags by one IPC hop, so an announce in flight looks exactly like silence
there — and concluding "no integration" from that would take the legacy path and
retype the original bug. Only the worker's own answer can end the wait.

Residual gaps, by design:

- A blocking or very slow **`/etc/zshenv`** (system-wide, runs before ours) delays the
  announce past the grace. Nothing user-level can; the 5s bound is about the shell's
  own speed, not IPC timing.
- Announce sent, then a `.zshrc` tears out our hooks, or `add-zle-hook-widget` is not
  loadable at `precmd` despite the version check → `I` with no possible `R` → the
  readiness timeout fails the script. Annoying, but fail-closed: it never corrupts.
  The version check is deliberately a proxy for "can deliver"; globbing `$fpath`
  instead would misfire for rc files that extend `fpath` later, and misfiring there
  is fail-**open**.
- No announce → the old racy heuristic. Not a regression: that is what those shells
  have today.

### Known gap: ZLE widgets that read stdin

`C` is emitted from `preexec`, which does **not** fire for foreground readers launched
by a ZLE widget — `fzf` on Ctrl-R is the common one. The line editor is still "active"
by zsh's reckoning, so `atPrompt` stays true while fzf owns stdin, and a script
launched at that instant types into fzf.

zsh offers no hook for it. The only sound signal is the pty's foreground process
group, which node-pty does not expose. It needs someone to be using a script terminal
interactively at the exact moment a script is injected, so it is narrow — but it is
fail-open, unlike the gaps above, and worth closing if the foreground-pgid route ever
becomes available.

## Why `zle-line-init`, not `precmd`

The obvious hook is `precmd` (which already emits OSC `633;A`). It is **too early**:

- `precmd` runs _before_ prompt expansion, which can itself run command
  substitutions and prompt plugins that read input.
- Our hook is registered from `.zshenv`, so it runs _before_ any `precmd` hook a
  later `.zshrc` adds — including one that blocks on `read`.

`zle-line-init` fires only once the line editor has actually taken the line. That is
the moment injected input is safe, so that is where the marker is emitted
(`packages/server/src/terminal/shell-integration/zsh/paseo-integration.zsh`).

Three gotchas in that hook:

- It is registered lazily **from `precmd`**, not at source time. The integration is
  sourced from `.zshenv`, where zle is not loaded yet and `zle -N` is a no-op.
- It uses `add-zle-hook-widget` (zsh 5.3+), never `zle -N zle-line-init`, which
  would silently replace a user's own widget.
- The "already registered" latch is set **after** registration succeeds. Latching
  first would turn one transient failure into a shell that never reports readiness
  again — the same shape as the resize latch bug in #2059.

## Protocol

| OSC              | Meaning                                 | Emitted from    |
| ---------------- | --------------------------------------- | --------------- |
| `633;I;<nonce>`  | Integration loaded; readiness is coming | `.zshenv` (top) |
| `633;R;<nonce>`  | Line editor has the line — safe to type | `zle-line-init` |
| `633;C;<nonce>`  | Command took the foreground — not safe  | `preexec`       |
| `633;D;<status>` | Command finished                        | `precmd`        |

`633;I` and `633;R` are Paseo's own; `C`/`D` follow VS Code's shell integration shape.
`C` carries the nonce because it is what says "stop typing": a bare `633;C` from
foreign output would otherwise strand the next script on the timeout.

The integration files are copied to a runtime dir under `$TMPDIR` that `ZDOTDIR`
points at, **keyed by a hash of their contents**. Every daemon on the machine writes
these files and different Paseo versions ship different contents, so a single shared
path let an older daemon overwrite a newer integration — a shell starting in that
window silently lost the markers the daemon spawning it was waiting for. One dir per
version means they cannot clobber each other.

Terminals live in a worker process, so prompt state crosses to the daemon as a
`terminalPromptState` event (`terminal-worker-protocol.ts`). Ordering rules that the
manager must keep — each has a test in `worker-terminal-manager.test.ts`:

- `terminalCreated` carries the spawn-time state snapshot and the worker subscribes
  before sending it, so a prompt event can never arrive ahead of its record. Events
  for unknown ids belong to already-exited terminals and are dropped.
- `terminalCreated` and the create response both register the same record, so
  re-registration must not roll live prompt state back to the spawn-time snapshot.
  This is why `promptState` lives on the record, not inside `info`.
- Exit forces `atPrompt` false.

## Failure behavior

`waitForTerminalInputReadiness` subscribes **before** re-reading the state (the
marker can land in the gap), rejects immediately on terminal exit, and otherwise
times out after 15s with a `TerminalNotReadyError`. For an announced shell it never
types anyway — that would reintroduce the exact bug.

The wait only proves the shell **was** ready. The write re-checks: for an announced
shell the command goes through `sendInputIfAtPrompt`, which the worker answers by
checking and writing in the same tick against the live session. If the shell lost its
prompt in between, nothing is sent and the script fails with `reason: "raced"` —
recoverable by re-running, and it keeps its terminal like a timeout does. Legacy
shells send unguarded: they never report a prompt, so guarding the write there would
mean never typing at all.

On a readiness timeout the terminal is **left open**: it holds the prompt the user
needs to answer. For plain scripts the runtime entry is preserved with its
`terminalId`, so re-running reuses that same shell — answer the prompt, run again,
and the command lands intact. Service scripts get a freshly planned port on the next
run and their terminal's env carries the old one, so reuse would be wrong; their
entry is dropped and the retry starts clean.

## Known gap: non-zsh shells

Only zsh ships an integration, so only zsh ever announces. bash, fish and custom
shells fall back to the old heuristic (first output, or 1.5s) and remain exposed to
the corruption above. There is no reliable shell-agnostic PTY readiness
signal — foreground process ownership and terminal modes cannot tell a line editor
from a `read` inside an rc file — so each shell needs its own integration. The nonce
env var is injected for every shell so a bash/fish hook can adopt the same marker
without a protocol change.
