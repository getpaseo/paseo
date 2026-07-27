# Dev Containers

A workspace can run its agents and terminals inside a container instead of on the host. The user picks a **container backend** per workspace; `null` means Host (no isolation) and is the default. Today the only backend is `devcontainer`, which shells out to [`@devcontainers/cli`](https://github.com/devcontainers/cli) and Docker.

## The pieces

| Piece                                         | Responsibility                                                                                                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `devcontainer/container-backend.ts`           | `ContainerBackend` interface — lifecycle (`up`/`stop`/`restart`/`rebuild`), availability, config detection, `ContainerInfo` for the UI                          |
| `devcontainer/devcontainer-service.ts`        | The one implementation: runs `devcontainer up`, parses its JSON result, inspects the container                                                                  |
| `devcontainer/container-backend-registry.ts`  | Backend ID → backend. `listAvailable(cwd)` feeds the workspace's backend picker                                                                                 |
| `devcontainer/launch-strategy.ts`             | `ProcessLaunchStrategy` — the seam every spawn goes through. `LocalLaunchStrategy` spawns on the host; `ContainerExecLaunchStrategy` execs into the environment |
| `devcontainer/launch-strategy-registry.ts`    | Which workspace has which strategy, plus the pending-activation gate agents and terminals await                                                                 |
| `devcontainer/container-probe-coordinator.ts` | The new-workspace screen's probe: throwaway container, provider entries, cancellation and de-duplication                                                        |

Adding a backend means implementing `ContainerBackend`, including a `createStrategy` that returns a `ContainerExecSpec`. Nothing outside `devcontainer/` knows about Docker.

## Container identity

Every container carries the key it belongs to, so the in-memory key and the container's real identity can never disagree:

```
devcontainer.local_folder = <workspace folder>     # what the CLI would infer
devcontainer.config_file  = <devcontainer.json>    # what the CLI would infer
paseo.container           = <workspaceId | probe:<uuid>>
paseo.owner               = workspace | probe
```

`--id-label` **replaces** the labels the CLI infers from the workspace folder, so the folder ones are re-supplied verbatim — other devcontainer tooling still recognises the container, and label filters are subset matches. The Paseo labels are what adoption queries on (`docker ps --filter label=paseo.container=<key> --filter label=devcontainer.local_folder=<folder>`), which is what makes the following true:

- Two workspaces on the same directory get two containers instead of silently sharing one.
- A probe cannot adopt — or stop — a workspace's container, even for the same directory. Before this, probing a directory that already had a running workspace container would `docker stop` it out from under the running agents.
- Abandoned probe containers are identifiable, so the daemon can reap them at startup.

The cost: these labels are a CLI convention we reproduce rather than a documented contract, and VS Code opening the same folder no longer deterministically lands on the same container as Paseo. `real backend: a probe and a workspace on the same directory get separate containers` is the test that fails if the convention changes.

## What runs where

| Work                                     | Where it runs | Why                                                                                            |
| ---------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------- |
| Agent processes                          | Container     | The point of the feature                                                                       |
| Terminals                                | Container     | Same shell the agent sees                                                                      |
| Agent-requested commands (ACP terminals) | Container     | The agent asks for them in its own workspace                                                   |
| Provider catalog / model probes          | Container     | The container's tool version is the one that will run, so the host's model list would be wrong |
| Git                                      | **Host**      | See below                                                                                      |
| Container lifecycle itself               | Host          | `devcontainer up`, `docker stop`, `docker inspect`                                             |

### Git runs on the host

`runGitCommand` never routes through a launch strategy. The workspace folder is bind-mounted, so host git operates on exactly the same files, and:

- Worktree lifecycle (add/remove) happens before any container exists.
- Credentials, SSH agent, and the user's git config live on the host.
- A stopped container would otherwise mean no branch, no status and no Changes view at all.

If you are tempted to make git container-aware, that is the list to answer first.

### The agent's git, which is a different question

Paseo's git running on the host says nothing about the agent's. An agent is a shell inside the container and will run `git status`, `git diff` and `git commit` of its own accord. For a plain clone that works — `.git` is a real directory inside the mount, and nothing in it names the host. For a **linked worktree** it does not, because a worktree is three paths pointing at each other and two of them are absolute:

```
wt/.git                          →  /repo/main/.git/worktrees/wt   ← absolute
main/.git/worktrees/wt/commondir →  ../..                          ← relative
main/.git/worktrees/wt/gitdir    →  /repo/wt/.git                  ← absolute, points back
```

Only the workspace folder is mounted, so the first dangles and the agent gets `fatal: not a git repository`.

`devcontainer up --mount-git-worktree-common-dir` mounts the git directory where the relative link resolves. It only works when the worktree's links **are** relative, and it does nothing at all otherwise: no warning, no error, `outcome: success`, git still dead. So the decision is made at creation, from two facts already in hand:

- **Is this a worktree?** The new-workspace request says so — it is what the user chose in the isolation picker. Nothing stats the directory for it, which would also read a submodule's `.git` file as a worktree's.
- **Can git read relative links?** Only the **host's** git is checked. That looks like an omission and is not: linking one worktree relatively marks the whole _repository_ with `extensions.relativeWorktrees`, so the choice is not per-container. Every workspace on that repository lives with it — sibling worktrees, the main checkout, and whichever containers each of them runs in — so asking one image would answer for all of them.

If the workspace has a container backend and the host's git is 2.48+, the worktree is created with `--relative-paths` and its container starts with `--mount-git-worktree-common-dir`. Otherwise it is created the ordinary way, and the agent's git sees nothing — as before.

**What an old git in the image does then.** It refuses the repository outright:

```
fatal: unknown repository extensions found:
	relativeworktrees
```

and it refuses it for **every workspace on that repository**, not only the worktree — including a plain non-worktree workspace on the main checkout. A separate clone is unaffected, because the extension is per-repository and clones do not inherit it. This is the cost of the feature being repo-wide, and it is why the host gate is the honest place to draw the line: an image that old could not have used a relative worktree anyway.

**Worktrees are also locked.** `git worktree prune` deletes the admin directory (HEAD, index, reflog) of any worktree whose `gitdir` names a missing path, and `git gc` runs it on a three-month timer. A container mounts one worktree, so every _sibling_ reads as missing from inside it — an agent running `git gc` there would delete another workspace's state, and `git worktree repair` cannot undo it. `git worktree lock` at creation makes that impossible.

The lock cuts both ways, because prune is also how a _stale_ registration gets healed: a worktree whose directory went away without git being told keeps its branch pinned, and restore depends on clearing it. So the paths that heal one call `unlockStaleWorktrees` first, which unlocks only entries whose directory is already gone. Removing a Paseo worktree by hand now takes `git worktree remove -f -f` or an unlock; the lock reason says so.

## Gotchas that cost real time

- **`docker exec` argument order.** `exec [OPTIONS] CONTAINER COMMAND [ARG...]`. Every flag has to precede the container ID; anything after it is the command. `ContainerExecSpec` splits `optionArgs` from `targetArgs` so assembly can't get this wrong — don't flatten it back into one array.
- **`-i` or nothing works.** Agent processes are driven over stdin. Without `-i` the process sees EOF immediately and exits, which surfaces as "stream ended before terminal result" rather than anything about stdin.
- **`-t` only for terminals.** A TTY on a piped agent process breaks its stdout framing. `wrapCommand({ interactive: true })` adds it; `spawn` never does.
- **`-e KEY` (no `=value`) unsets a variable.** Paseo sets some variables to `undefined` to clear them (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, …). The container may set them itself, so they have to be explicitly unset rather than merely not passed.
- **The pty's cwd is a host path.** For a container terminal, node-pty spawns `docker` on the host; the container-side directory travels in `-w`. Handing the pty a container path makes it fail to spawn.
- **The agent must be on the container's PATH.** Whether it is installed in the image or arrives through a bind mount is the image's business — Paseo only asks the container to resolve the name. The daemon's `process.execPath`, an SDK's bundled `cli.js`, and a `which`-resolved host binary are host paths and are never used for an isolated launch. Claude specifically: `pathToClaudeCodeExecutable` is set to whatever the container resolved, which has no JS extension either way, so the SDK treats it as a native binary and passes only CLI flags.
- **"Not on the PATH" while the terminal runs it fine.** `docker exec` starts a bare process, so its PATH is only what the image declares — often just `/usr/local/bin:/usr/bin`. A terminal runs a _shell_, which adds whatever `~/.profile` and `~/.bashrc` put there, and that is where `~/.local/bin`, nvm, and most per-user installs live. So `resolveExecutable` asks the environment's own login shell (`-lic`, then `-ic`, then plain `-c`), and returns the **absolute path** it prints — which also means the launch itself no longer depends on the exec's PATH. Startup files that print banners are handled by marking the answer line rather than reading whatever came out last.
- **`resolveExecutable` checks before launching.** Cached per command for the container's lifetime, but **only on success**: a container still finishing its start would otherwise be remembered as "agent missing" until it was rebuilt. Without the check at all, a missing agent surfaces as `exited with code 127` plus a runtime message about `crun`, which says nothing about what to fix.
- **The agent's own subprocesses still get the image's PATH.** Only the agent binary is resolved through the shell. A tool the agent shells out to that lives in a startup-file PATH entry will not be found, even though the same command works in a container terminal.
- **`isAvailable()` takes the launch strategy, it is never skipped.** A provider that gates on a binary answers for the container; one that gates on something else — an opt-in env var, a disabled provider — still gets to say no. Skipping the check for isolated launches (an earlier attempt at the same problem) let a dev-only provider whose `fetchCatalog` never resolves into the new-workspace probe, which then took the full 60s catalog timeout instead of ~3s.
- **The agent authenticates inside the container.** `~/.claude`, `~/.codex` and friends are the container's, not the host's. Mount or provision them in devcontainer.json.
- **The terminal shell comes from the container.** `resolveDefaultShell()` asks the environment for `$SHELL`, falling back to the user's passwd login shell and then to `/bin/sh`. Set `containerEnv.SHELL` in devcontainer.json to pick a specific one. The host's `$SHELL` is never used for a container terminal — `/opt/homebrew/bin/fish` doesn't exist in a Debian image.

## Environment variables

`resolveContainerEnvEntries` decides what crosses the boundary:

- **Explicit overlays** (`envOverlay`) always cross, including `undefined` values, which unset.
- **Base env entries cross only when the caller changed them** relative to the daemon's own `process.env` — an added API key, a deleted `NODE_OPTIONS`, `PASEO_AGENT_ID`. An unchanged value carries no intent.
- **`PATH`, `HOME`, `SHELL`, `USER`, `TMPDIR`, …** never cross. The image owns them; overriding `PATH` breaks command resolution immediately.

Host environment variables reach the container the way the Dev Container spec intends: `containerEnv`/`remoteEnv` in devcontainer.json, which can pull from the host with `${localEnv:NAME}`. Paseo does not smuggle the daemon's environment past that.

## Reaching the daemon from inside

The daemon binds `127.0.0.1` by default, which inside a container means the container itself. Two features depend on reaching back:

- The agent MCP endpoint (`/mcp/agents`)
- Terminal activity reporting (`PASEO_TERMINAL_ACTIVITY_URL`)

`ContainerExecLaunchStrategy.resolveDaemonUrl()` rewrites a loopback URL to the container's default gateway (captured as `hostGatewayAddress` at `up` time). That only helps if the daemon is actually listening on something other than loopback — bind it to `0.0.0.0` to enable these features for container workspaces. When there is no reachable address, `AgentManager` **drops** the injected MCP server and logs a warning rather than handing the agent a URL that costs it a full tool-call timeout per call.

## A stopped container is not an error

`ContainerNotRunningError` separates two readings of "this workspace wants a
container and there isn't one":

- **Agent and terminal creation refuse.** Running them anyway would put them
  outside the container the user asked for.
- **A catalog refresh reports the providers as `unavailable`.** The container's
  tool list is unknown until it starts, which is not a failure the user can act
  on — and marking every provider `error` turns the model picker red for a
  workspace that is merely stopped.

Relatedly, a snapshot refresh is answered for whichever workspace owns the
directory, so the new-workspace screen has to say which environment it means:
`refresh_providers_snapshot_request` with `containerBackend: null` asks for the
host explicitly. Without it, pointing that screen at a directory that already
holds a stopped container-backed workspace answers for _that_ workspace.

## No fallback to the host

If a container is required and not running, agent and terminal creation **fail**. They never quietly run on the host — the user asked for isolation, and silently not providing it is worse than an error. Concretely:

- `awaitStrategy` blocks on a pending activation and rejects if it never arrives.
- Every failure path calls `deactivateContainer`, which resolves waiters. A path that forgets leaves agent creation hanging forever.
- A provider that doesn't honor the launch strategy is refused on container workspaces via the `supportsIsolatedLaunch` capability. OpenCode does not honor it yet; Claude, Codex, OMP, Pi, and ACP providers do.

## The new-workspace probe

Picking a container backend for a workspace that doesn't exist yet raises a question only the container can answer: which providers are installed, and what models do they offer? The daemon answers it by building a throwaway container, listing each provider inside it, and removing the container again (`ContainerProbeCoordinator`).

Things worth knowing before touching it:

- **The probe response is the whole answer.** `container.probe.response` carries the provider entries, and the client writes them straight into the snapshot cache the model picker reads. It must not follow up with a snapshot refresh: the probe container is already gone, so that refresh would resolve to the host and overwrite good container results with host ones (or with an error per provider).
- **The shared snapshot is never written.** A probe uses a private snapshot key, so workspaces already open on that directory keep their own provider list.
- **Everything here is cwd-scoped, not workspace-scoped.** No workspace record exists yet, and none is needed: the model picker reads the snapshot by `cwd` (`useAgentFormState` → `useProvidersSnapshot({ cwd })`), which is where the probe's entries are applied. Note that `ProviderSnapshotManager`'s `scope: "workspace"` means "scoped to a cwd" as opposed to global/home scope — it does not imply a workspace exists. The probe must use it because that is the only scope carrying a `launchStrategy`; global scope would silently probe the host. The one thing that genuinely needs a workspace record is resolving which container to use, which is why the probe passes its strategy in directly instead of going through the cwd → workspaceId → backend resolver.
- **`isAvailable()` is skipped for isolated launches.** It inspects the host, so for a container it answers about the wrong machine — a tool present only in the image would read as missing. Fetching the catalog inside the container is the test instead.
- **Probes are cancellable and de-duplicated.** Picking a different backend supersedes the running probe, an identical request joins it rather than building a second container, and disconnecting cancels everything the session started. Cancellation kills the CLI and removes whatever it built.
- **Progress is streamed.** `devcontainer up` output arrives as `container.probe.progress` events while it runs, because a first build takes minutes.
- **The client debounces** dropdown changes and caches per `(cwd, backend)`, so toggling Host ↔ Dev Container doesn't re-probe.

Probe containers are deliberately **not** adopted by the workspace that gets created afterwards. Labels are immutable, so a container created as `paseo.owner=probe` would be serving a workspace while claiming to be scratch — the next daemon start would fail to find it, build a second one, and orphan the first. The cost is that the container is built twice; `postCreateCommand` re-runs on the workspace's own container.

## Lifecycle

- Containers **outlive the daemon**. On restart, `isAlreadyRunning` finds one by its `paseo.container` + `devcontainer.local_folder` labels and adopts it instead of rebuilding — same as VS Code's behavior. Both labels are matched: the key alone would also find a container created for that key against a different folder.
- `up()` re-inspects a cached handle before reusing it, because containers get stopped or rebuilt from outside Paseo.
- **Archiving a workspace stops its container**, as does switching the workspace off that backend. Unarchiving starts it again.
- Availability (`devcontainer` + `docker` on PATH) is cached for 60s. Docker is routinely started after the daemon, so a negative answer must not stick for the process lifetime.
- Probe containers are removed when their probe ends, and any that survive a daemon crash are reaped at the next startup (`removeAbandonedProbeContainers`).
- `devcontainer.json` is watched; a hash change emits `container.config_changed` so the client can offer a rebuild.
- **Container details for the UI are captured when the container starts**, not queried per read. The workspace badge and the sidebar's container icon show backend, image, container name, user and start time, and a workspace descriptor is rebuilt on every workspace update — so a descriptor that queried the runtime, or that emitted an update once its answer arrived, would loop and burn a `docker inspect` per cycle. `getContainerInfo(key)` is a synchronous read of what `up` recorded.

## Transcripts live where the agent ran

Providers keep session transcripts outside the workspace: Claude in
`~/.claude/projects/<encoded-cwd>`, omp in its session directory. Paseo reads
them to list importable sessions and to replay a resumed conversation.

For a container workspace those files are the **container's**. Two things about
them differ from the host, and both matter:

- They are under the **container's HOME**, which is its user's, not yours.
- Claude's directory name encodes the **cwd the agent saw** — `/workspaces/app`,
  not `/home/you/app` — so even a mounted `~/.claude` would not line up.

`LaunchFileSystem` (`devcontainer/launch-filesystem.ts`) is the seam: the host
implementation is plain `node:fs`, the container one runs the equivalent POSIX
commands (`find`/`stat`, `cat`, `head -c`, `tail -c`, `rm -rf`) through the
workspace's launch strategy. Listing is a single `find … -exec stat` rather than
a walk plus one exec per file. Claude, omp and Pi all read through it, so their
import lists, replayed history, and Claude's ephemeral-transcript sweep all
address the environment the agent actually ran in.

### Files a provider is configured through

The same seam writes, for the mirror-image reason. Pi is configured by paths it
opens itself — `--mcp-config` and `--extension`, the latter carrying the system
prompt — and the daemon's `/tmp` is not the container's, so a host temp file
would be a path Pi cannot open. `makeTempDir` and `writeFile` put them where Pi
will look (`mktemp -d`, then `mkdir -p && cat >` over stdin). Two rules hold
there:

- **Writes throw where reads answer null.** A config file that never landed
  surfaces much later as an agent that quietly lost half its tools.
- **Credentials get their mode in the same command.** The MCP config names the
  daemon's endpoint and auth token, so `writeFile` takes a `mode` and the
  container path chmods in the same `sh -c` — never a window where it is
  world-readable between two execs.

Pi's _global_ config is read the same way: `~/.pi/agent/mcp.json` is merged
into the generated one, and for a container workspace it is the container's
copy under the container's HOME, not the daemon's.

Both are local disks; what differs is the cost of reaching one. A host read is
a `readFileSync` (~1ms); a container read is a process spawn (~75ms measured
against podman). That is why Claude's history load became async — 75ms of
blocked event loop per resumed session, in a constructor, would stall every
other session on the daemon — and why the listing is a single `find` rather
than a walk plus a stat per file.

Async would normally leave a standing hazard — `persistedHistory` and the
rewind anchors not yet populated when the constructor returns, and a reader
that forgets to wait seeing an empty history rather than an error. Instead the
load happens **before the session escapes its factory**:
`ClaudeAgentClient.resumeSession` awaits `hydratePersistedHistory()`, and the
one path that swaps the session id mid-life (`rebindConversationSession`, via
rewind's now-awaitable `setSessionId`) awaits its own reload. There is no
window in which a caller holds a session whose history is still arriving, so
no reader needs to remember anything.

## Testing

`packages/server/src/server/container-management.test.ts` holds both layers:

- Unit tests with a mock backend for session wiring, status, and the strategy's own logic.
- `dockerTest(...)` cases that run a real `devcontainer up` against `alpine:latest` and assert commands actually execute inside the container. They skip when Docker isn't on PATH.

The real-container tests are the ones that catch exec-argument and environment mistakes; the unit tests cannot.

For provider-side work there is a third option:
`devcontainer/test-utils/fake-isolated-strategy.ts` reports `isIsolated`, maps
paths the way a container does, and runs the resulting POSIX commands on the
host. Most container support is a question of _which_ environment a provider
addresses — where it spawns, where it writes the files the agent opens, where
it looks for transcripts — and that is answerable without a runtime. Pi's
container tests use it; what it cannot tell you is whether a real image
behaves the same, which is what the docker-gated tests are for.

## Known gaps

- **OpenCode** doesn't route through the launch strategy, and can't with the current seam: it isn't a subprocess Paseo spawns but a shared HTTP server (`opencode serve --port N`) that every workspace multiplexes over by passing `directory`. Containerizing it means a server per container, a way for the daemon to reach a port inside it, container paths in `directory`, and its `$PASEO_HOME/opencode-home` state moving too. Container workspaces refuse it for agent runs, and its importable-session list comes back empty there rather than offering the host's sessions.
- **Shell integration and the bundled `paseo` hook CLI** are injected into the host-side environment (`buildTerminalEnvironment` prepends host paths), so a container terminal doesn't get zsh integration or the hook CLI on its PATH.
- **Provider catalogs are fetched for every configured provider** during a probe, so a machine with several configured providers pays several in-container spawns per probe. Fetching only the selected provider's catalog would need the probe container to survive, which option B deliberately gives up.
- **The provider snapshot is keyed by cwd**, so two workspaces sharing a directory with different backends overwrite each other's provider list. Fixing it properly means keying snapshots by workspace, which is a refactor beyond the container feature. The probe itself no longer contributes to this: it never writes the shared snapshot.
- **A subdirectory workspace mounts the whole repository.** The devcontainer CLI's `--mount-workspace-git-root` defaults to **true**, and Paseo does not override it, so pointing a workspace at `repo/packages/app` mounts `repo` at `/workspaces/repo` and sets the workspace folder to `/workspaces/repo/packages/app` inside it. That is how git works in those containers — and it is more of the host than the workspace folder. `ContainerExecSpec.hostWorkspaceFolder` is still the workspace cwd, so `resolveCwd` treats a sibling directory as outside the workspace and falls back to the workspace folder, even though the sibling is genuinely present in the container.
- **A worktree created inside a container is registered with container paths.** The admin directory persists in the host repo, but its `gitdir` names a path only the container had, so the host reads it as prunable and refuses to check that branch out (`already used by worktree at /workspaces/…`). If the worktree also landed outside the mount, its files are gone with the container. Paseo has no record of it either way.
