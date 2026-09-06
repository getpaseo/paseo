# Architecture

Paseo is a client-server system for monitoring and controlling local AI coding agents. The daemon runs on your machine, manages agent processes, and streams their output in real time over WebSocket. Clients (mobile app, CLI, desktop app) connect to the daemon to observe and interact with agents.

Your code never leaves your machine. Paseo is local-first.

## System overview

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  Mobile App  │    │     CLI     │    │ Desktop App │
│   (Expo)     │    │ (Commander) │    │ (Electron)  │
└──────┬───────┘    └──────┬──────┘    └──────┬──────┘
       │                   │                  │
       │    WebSocket      │    WebSocket     │    Managed subprocess
       │    (direct or     │    (direct)      │    + WebSocket
       │     via relay)    │                  │
       └───────────┬───────┴──────────────────┘
                   │
            ┌──────▼──────┐
            │   Daemon    │
            │  (Node.js)  │
            └──────┬──────┘
                   │
      ┌────────────┼────────────┬────────────┬────────────┐
      │            │            │            │            │
┌─────▼─────┐ ┌───▼────┐ ┌──────▼─────┐ ┌────▼─────┐ ┌────▼────┐
│  Claude   │ │ Codex  │ │  Copilot   │ │ OpenCode │ │   Pi    │
│  Agent    │ │ Agent  │ │   Agent    │ │  Agent   │ │ Agent   │
│  SDK      │ │ Server │ │    ACP     │ │          │ │         │
└───────────┘ └────────┘ └────────────┘ └──────────┘ └─────────┘
```

## Components at a glance

- **Daemon:** Local server that spawns and manages agent processes and exposes the WebSocket API.
- **App:** Cross-platform Expo client for iOS, Android, web, and the shared UI used by desktop.
- **CLI:** Terminal interface for agent workflows that can also start and manage the daemon.
- **Desktop app:** Electron wrapper around the web app that bundles and auto-manages its own daemon.
- **Relay:** Optional encrypted bridge for remote access without opening ports directly.

## Packages

### `packages/server` — The daemon

The heart of Paseo. A Node.js process that:

- Listens for WebSocket connections from clients
- Manages agent lifecycle (create, run, stop, resume, archive)
- Streams agent output in real time via a timeline model
- Provides agent-to-agent tools through a transport-neutral tool catalog, with MCP as one adapter
- Optionally connects outbound to a relay for remote access
- Optionally serves the browser web client from the same HTTP server (self-hosting guide: [public-docs/web-ui.md](../public-docs/web-ui.md))

All paths are under `packages/server/src/`.

Project identity is daemon-global rather than session-owned. After registry bootstrap, the daemon's
project Git observer keeps one non-recursive watch on each lexically equivalent active project root
and listens only for the root `.git` entry, with a slow rescan as a missed-event fallback. It runs
for empty projects and without connected clients, then fans metadata changes through the WebSocket
server to capability-aware sessions. It deliberately does not use the broad recursive working-tree
watcher or the per-session Git observer: those are checkout/status mechanisms and intentionally do
not retain non-Git directories.

**Key modules:**

| Module                          | Responsibility                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------ |
| `server/bootstrap.ts`           | Daemon initialization: HTTP server, WS server, agent manager, storage, relay   |
| `server/websocket-server.ts`    | WebSocket connection management, hello handshake, binary frame routing         |
| `server/session.ts`             | Per-client session state, timeline subscriptions, terminal operations          |
| `server/directory-sync/`        | Daemon-global latest-state sequences for projects, workspaces, and agents      |
| `server/workspace-labels/`      | Host-local label catalog, assignment mutations, and explicit subscriptions     |
| `server/agent/agent-manager.ts` | Agent lifecycle state machine, timeline tracking, subscriber management        |
| `server/agent/agent-storage.ts` | File-backed JSON persistence at `$PASEO_HOME/agents/`                          |
| `server/agent/tools/`           | Transport-neutral catalog for workspaces, agents, permissions, and automation  |
| `server/agent/mcp-server.ts`    | Thin MCP adapter that registers the Paseo tool catalog with the MCP SDK        |
| `server/agent/providers/`       | Provider adapters (see "Agent providers" below)                                |
| `server/orchestration-skills/`  | Bundled catalog, host selection, convergence, and skill-directory transactions |
| `server/relay-transport.ts`     | Outbound relay connection with E2E encryption                                  |
| `server/schedule/`              | Cron-based scheduled agents                                                    |

### `packages/protocol` — Wire schemas and shared protocol types

The source of truth for WebSocket messages, binary frame codecs, endpoint parsing,
agent timeline types, provider config schemas, and other values shared by daemon
and clients. Server, app, CLI, and `@getpaseo/client` all depend on this package;
it does not depend on the server.

### `packages/client` — Daemon client library and SDK facade

Owns the low-level daemon WebSocket driver plus the higher-level `PaseoClient`
facade. App and CLI may import the low-level driver from
`@getpaseo/client/internal/daemon-client` during migration, while new SDK-shaped
code imports from `@getpaseo/client`.

`PaseoApi` is the capability-only boundary over workspaces, agents, providers, and config.
`PaseoClient` adds connection lifecycle. App plugin surfaces borrow an API over their selected
host's client; plugin subprocesses use the same facade over a host-owned IPC transport.

### `packages/app` — Mobile + web client (Expo)

Cross-platform React Native app that connects to one or more daemons.

- Expo Router navigation (`/h/[serverId]/workspace/[workspaceId]`, `/h/[serverId]/agent/[agentId]`, etc.). The `workspaceId` URL segment is an opaque workspace id, not a directly meaningful filesystem path.
- `HostRuntimeController` manages saved host connections, reconnection, and per-host runtime state. Direct TCP and relay connections use the ordinary client transport; desktop socket, pipe, and SSH connections cross one Electron-owned transport boundary. SSH only tunnels to an already-running daemon.
- `runtime/replica-cache` is typed storage behind the directory and timeline owners. It never observes or mutates `SessionStore`.
- `runtime/directory-sync` owns directory cache selection and network reconciliation. On demand it paints accepted rows for one host, then passes the persisted per-entity cursor through `project.list`, `fetch_workspaces`, and `fetch_agents`; the daemon returns each entity's latest projection when its sequence is newer, plus tombstones.
- `workspace-labels` owns one sequenced catalog replica per connected host, the deterministic cross-host projection that surfaces spanning hosts use (the filter page, the manager), and the per-host resolution a workspace row's chips use. Two hosts may give one name different colors, so a row resolves against its own host's catalog and a merged answer would be wrong there. Catalogs never synchronize between hosts; assignment creates a missing definition only on the target host. On the daemon, catalog and assignment rewrites share a journaled commit boundary. Startup recovery completes that commit before workspace or catalog publication.
- `SessionContext` wraps the daemon client for the active session
- Composer UI and submit/draft behavior live in `packages/app/src/composer/`; screens and panels should integrate it from there instead of dropping composer internals into `components/`, `hooks/`, or `screens/workspace/`
- Timeline reducers in `timeline/session-stream-reducers.ts` handle compaction, gap detection, sequence-based deduplication
- Timeline sync correctness is documented in [docs/timeline-sync.md](timeline-sync.md): live streams are for immediacy, `fetch_agent_timeline_request` is authoritative, and catch-up is paged but complete.
- Voice features: dictation (STT) and voice agent (realtime)

Consumers request directory or timeline data without choosing memory, cache, or network. The owner
publishes an accepted cache hit and then reconciles it over the existing network path. A miss or an
invalid row uses that same path. Offline demand still publishes an accepted cache hit and defers
network reconciliation. Cache loading is demand-driven: opening a chat reads its agent row and
focused timeline row, plus the workspace and project rows needed by the route; opening a directory
reads directory rows for that host and establishes its live subscription when connected. Accepted
cached rows satisfy the same consumer-readiness projection as network rows. Host registry startup and
host connection do not create directory demand or install replicas. The directory owner retains
declared surface demand and re-establishes network reconciliation after reconnect; React does not
track connection generations. Late cache reads cannot replace state already advanced by live or
authoritative network data. Owners explicitly persist accepted commits; directory rows and their
checkpoint share one storage transaction. See
[data-model.md](data-model.md#replica-row-store)
for the storage shape and [timeline-sync.md](timeline-sync.md#client-replica-lifetime) for timeline
resume behavior.

The three directory entity types have independent monotonic sequences and share one daemon
generation. The daemon retains only the latest projection per entity and bounded tombstones, not an
event log. A missing, expired, or previous-generation cursor receives a full snapshot. Projects are
independent records; a project with no workspaces does not need a workspace placeholder.

#### Durable assistants

Assistants are their own principal-scoped records, independent of projects and
workspaces. A template supplies a copy of the initial configuration; editing or
deleting it never changes an existing assistant. The launcher selects an instance
on a host, and its settings override per-call voice, instructions, and backend
model settings. The backend thinking setting is not a control for the realtime
speaking model's reasoning effort.

Each call still creates an ephemeral provider host. The daemon saves finalized
speech and call boundaries, then seeds a fresh realtime conversation from the
assistant's configured context, user-written summary, and recent unsummarized
history. Speech keeps its original role. This restores text context, not the
provider's internal session or audio state. A disconnected call can have an
incomplete final utterance. History outside the startup budget remains readable;
see [data-model.md](data-model.md#assistant-records-and-history) for retention.

One assistant can have one active call across its owner's devices. Configuration
edits and compaction affect the next call. Deleting an assistant closes its call
and removes its local history; independently delegated project work keeps running.
Provider-owned rollouts are outside that deletion boundary.

Subscription-backed fire-and-forget execution is not implemented. The inspected
Codex WebSocket realtime path requires API-key authentication; WebRTC uses the
subscription path. The isolated `assistant-realtime-smoke.ts` script probes text
input, journal seeding, and provider restart without relying on an ordinary
executor turn as a replacement for the speaking model.

#### Live Voice ownership and cross-host routing

Live Voice is one daemon-global call per owning reconnectable client session. The daemon creates
a hidden host session for the realtime conversation; it is not attached to a
project or ordinary visible agent. Which agent provider hosts it comes from a
host profile (`agent/providers/live-voice-host-profiles.ts`) — the coordinator
and everything under `server/live-voice/` are provider-neutral, and the daemon
advertises the choice as `features.liveVoiceHostProvider`. Today the only
profile is Codex, with a 0.147.0 minimum because the hidden host relies on that
version's restricted tool configuration. Negotiation and control messages
travel over the existing authenticated Paseo WebSocket, while microphone and
remote speech media travel directly between the app's WebRTC peer and the
realtime provider. The app never receives or stores a provider API key for this
path: Codex uses its existing ChatGPT-subscription authentication to establish
the realtime session.

Live Voice requires **Enable Paseo tools** on its host. The app excludes hosts
that advertise the setting as off, and the daemon rejects the start request as
the authority. Do not offer a talk-only fallback: the hidden session exists to
inspect and control Paseo, and without those tools it cannot fulfill that role.

The authenticated client session owns the call across physical socket replacement.
The app pins that host connection during the call. A lost control connection
gets the existing bounded reconnect grace; it cannot retain a hidden host forever. Native background audio keeps the peer and
socket alive across Home/screen lock; the physical-device checks and platform
constraints are in [mobile-testing.md](mobile-testing.md).

On Android the foreground service's ongoing notification is the call's only
control surface once Paseo is backgrounded, so it carries Mute and End call. The
service never changes call state itself: a button press travels back through the
Expo module to the app runtime, which stays the only writer. iOS has no
equivalent — its module manages the audio session and nothing else, and a pinned
call presence there would mean a Live Activity.

Only the app knows the user's other hosts — `getSavedHosts` lives there and
nowhere in the daemon — so cross-host work exists only on this app-mediated
route. A daemon-side Paseo tool has no connection to another machine and cannot
grow one; anything "across all hosts" has to be a routing tool.

For clients advertising `live_voice_cross_host_router`, the hidden session gets
only routing tools: list compatible hosts, resolve a workspace by name, run one
read on every host at once, describe the ordinary tools and schemas on one host,
and execute one selected tool. The route is:

```text
hidden Live Voice host on A
  -> exact owning socket on A
  -> owning app (authorizes the active call, selects and pins B)
  -> authenticated existing socket on B
  -> B's top-level Paseo tool catalog
```

The hidden host is non-interactive and fail-closed. Its provider profile removes
native shell, browser, computer, image-generation, app/plugin, and subagent tools,
disables project instructions and web search, and runs with read-only sandboxing
and no approval prompts. Any provider permission request that still reaches the
host is denied immediately so it cannot hold the spoken conversation open. This
does not auto-deny work on an ordinary Paseo agent: those permission requests are
reported into the call, where the user can approve or deny them by voice through
`respond_to_permission`.

Each hop of that route is cheap; what is expensive is a model turn, because the
user hears silence for the whole of it. So the tools are shaped to spend hops
instead of turns — every one of them fans out concurrently rather than walking
the hosts, and the routing layer caches the host list for thirty seconds so a
fan-out does not pay a serial round trip through the owning app before its first
target is contacted. `find_workspace` takes the name as the user said it, fans
out `list_workspaces`, and returns the `serverId` and `workspaceId` to act on,
turning "archive the Refresh Paseo assembly workspace" into two turns rather
than one per host plus one per lookup. `run_paseo_tool_on_all_hosts` does the
same for any read, so "what's running?" is one turn regardless of how many
machines the user owns. The prompt hands the model the exact names of the common
Paseo tools for the same reason, so discovery is a fallback rather than an
opening move.

An app-side fan-out operation — one route message the app expands against its
own host connections — was considered and rejected. With the cached host list,
the requests already travel in parallel, so the critical path is one app round
trip plus the slowest target either way; what an app-side operation would save
is per-host message count on the app link, at the price of a new protocol
operation and a capability gate. Revisit only if measurement shows the app relay
itself hurting.

Only reads fan out, against an allowlist rather than a denylist, so a tool added
later is not fannable until someone decides it should be. Mass mutation is what
is being kept out: "archive it on all of them" is a sentence a user can say by
accident, and one misheard word should not reach five machines. The allowlist is
an ergonomic guard, not a privilege boundary — it is enforced on the requesting
side, and the model gains no authority it did not already have against a single
host. Read-ness itself is declared where each tool is written (`readOnly` on the
tool config, surfaced to MCP clients as `readOnlyHint`), and tests hold the
pieces together: the allowlist must equal the set of tools the catalog declares
read-only, the prompt must offer exactly the names the fan-out accepts, and
every tool the prompt calls "exact and stable" must exist in the catalog with
the arguments the prompt names — the first draft of that list already named a
tool this daemon does not have.

The prompt carries what a tool description cannot. A description is read once the
model is already considering that tool; the prompt shapes the decision before it
— how many machines there are, that they are reachable only through these tools,
that the user waits through every call in silence, and which reads answer the
whole question at once. The reasoning behind the allowlist stays out of it: the
model needs to know which reads fan out, not why the line was drawn there.

The prompt is assembled from named components
(`live-voice-context.ts`), each locked or optional. Locked components are the
ones a call is broken or unsafe without: identity, Paseo-as-authority,
Paseo-visible creation, and core routing. Optional ones — the tool cheat sheet,
cross-machine awareness, recipes, brief-delegation, speaking style — can be
turned off per user from the Live Voice settings, which also take free-text
standing instructions passed to the model verbatim. The client sends component
ids and instructions on `voice.live.start`; the daemon owns the registry and
ignores unknown and locked ids, so a client can never talk a call out of its
safety rules. A test walks every component and fails on a locked one whose
disable changes the prompt or an optional one whose disable changes nothing — a
dead toggle on the settings page.

The prompt also orders narration after action: the model starts the tool call,
then says what it started. The reverse — announce, then act — serialized a
spoken sentence in front of every tool call's argument generation. And it keeps
delegation prompts spoken-length: the model is told never to dictate code,
diffs, or step lists into a prompt, because it composes arguments serially
while the user hears silence, and the session it delegates to is the stronger
coder.

The hidden host session defaults to a fast, cheap model (`gpt-5.6-luna`). The
Live Voice settings can override model and thinking per user, sent as optional
fields on `voice.live.start`; the picker offers only models every eligible host
reports, and codex resolves an unknown id to its default, so a stale selection
or an older codex degrades to a working call rather than a failed one.

Expect little latency from that choice. Codex executes each action on a
_subagent_ thread it spawns off the host thread (`thread_source: subagent`,
`parent_thread_id` pointing at the host), and it pins that thread to its own
model and effort regardless of what the host thread is set to. Measured against
codex's own rollouts for a real call — 15 actions, one session:

| Stage                                                         | Median | Share |
| ------------------------------------------------------------- | ------ | ----- |
| Realtime model deciding, plus codex's handoff to the subagent | 9.5s   | 72%   |
| Subagent turn: think and emit the tool call                   | 2.4s   | 18%   |
| Paseo: routing, fan-out, and execution                        | 0.02s  | ~0%   |

So the double hop is real but cheap, Paseo is free, and almost three quarters
of the wait is inside the realtime API and codex's delegation, where nothing
here has a lever. What _is_ a lever is the number of actions: at ~13s each,
collapsing "archive the workspace I named" from ten calls to two is worth about
100 seconds, which is why the fan-out tools and the recipes exist and why the
prompt's job is to keep call counts down.

Two things the same measurement ruled out, recorded so they are not
re-litigated: argument size does not predict latency (Pearson r = +0.077 across
20–720 characters; two identical 720-character calls took 13.7s and 5.8s), so
verbose delegation prompts are a speech-quality problem rather than a speed
one; and the subagent already runs fast and cheap on codex's own preset, so
tuning the host model tier optimizes the 18% slice.

Every routed tool call logs `live_voice.timing.tool_start` / `tool_end` lines
to `daemon.log` (see `observeRoutedOperation` in `live-voice-coordinator.ts`).
`tool_start` carries `msSinceUserSpoke` — the bracket around everything opaque
on the model side: turn detection, thinking, argument generation, and any
backend-executor turn — plus `argChars`, the generation-cost proxy. If a
near-empty call shows the same gap as a 2,000-character one, the time is
thinking, not typing. Everything between `tool_start` and `tool_end` is Paseo's
own routing and execution. Transcript arrivals log at debug with sizes only;
transcript text never enters the log.

Resolution is classified, never decided: `find_workspace` returns
`unique_exact`, `ambiguous_exact`, `unique_partial`, `ambiguous_partial`, or
`none`, and the prompt permits action only on `unique_exact`. Two machines
holding a workspace with the same name is a question for the user, not a coin
flip, and the destructive tools still take a `workspaceId`. Matching folds case,
punctuation, and hyphens because the name arrives through a transcriber, and it
covers the directory name as well as the title.

Resolving and acting stay two separate turns on purpose. A combined
resolve-and-act tool would enforce the `unique_exact` rule mechanically instead
of by prompt, but the beat between the turns is where the model says "found it
on Desktop — archiving", which is the user's one interrupt window before a
destructive act on transcribed input. Keeping that window is worth the turn;
prompt-level enforcement of the ambiguous cases is the accepted residual risk.

A host with no result lands in one of two buckets, because a voice call must
narrate them differently: `unavailableHosts` could not be reached at all, while
`erroredHosts` answered and the tool failed there — which is the expected shape
when an agent-scoped read is fanned out to learn which machine owns the agent.
Classification reads the route error's code, kept on the broker's rejection;
unknown codes count as tool failures, because "that read failed on Desktop" is a
mild miss where "I could not see Desktop" claims an outage that is not
happening. A workspace listing that does not parse is reported the same way
rather than counted as an empty host. Neither bucket is ever presented as the
machine holding nothing.

Routed discovery uses a 30-second timeout instead of the broker's ten-minute
default. That default is sized for tools that wait on an agent turn; inherited
here, one quiet host would hold the call silent for ten minutes.

Work started that way runs longer than a sentence, so the route has a return
leg. The app records the agent id returned by a routed tool call. Every host
connection also feeds its normal agent-completion events into that registry, so
completion learned from a live directory delta, a delegated agent, or a
post-reconnect directory snapshot follows the same path. The app performs one
event-triggered timeline-tail read when it needs the final response; it does not
poll for status. A target-specific watcher remains a second event source for
permission and completion reports. The two sources are deduplicated before the
source daemon appends the news to the running conversation
(`thread/realtime/appendText`).

A fast agent can finish before the routed tool response returns its agent id.
The app temporarily keeps completion events observed after the route began and
claims one when the response supplies the id. Host and agent identity are keyed
by the connection that delivered the event, and any embedded identity must
match it. Replacing a target connection replaces its event handlers without
discarding call correlation, so a later completion on the new connection still
reaches the call.

The target daemon is never told which call the work belongs to — it has no
liveSessionId and can address no socket but the requesting one. The app holds the
correlation, and the source daemon still checks that the socket asking it to
speak owns the call it names. A report for a call that has ended is dropped
rather than spoken into whatever call came after it. Completion text is bounded
and credential-redacted before it crosses into the realtime conversation.

A call can also report agents it did not start, gated on a user setting that is
off by default. When it is on, the app turns on an ambient watch (`voice.live
.agent.watch`) on every connected host that advertises
`liveVoiceAmbientAgentReports`, and those hosts report every agent that finishes
a turn, errors, or asks for permission. Two things differ from a routed report
and both follow from nobody having asked for it:

- **Correlation is by host, not requestId.** There is no routed call to match, so
  the app resolves an unsolicited report through the host it armed the watch on.
  A host reporting work the app never asked it to watch resolves to nothing. The
  registration survives the whole call rather than retiring after one report.
- **The model may stay silent.** A routed report is an answer the user is owed,
  so its note says to speak. An unsolicited one says to use judgement and that
  saying nothing is a valid outcome. There is no burst coalescing or filtering in
  code; the user's own free-text guidance goes into the prompt verbatim and the
  model decides.

A turn-completed report does not claim that external work such as CI has
finished. The spoken summary preserves any pending-work qualification from the
agent. End-to-end monitoring remains an explicit heartbeat, schedule, monitoring
agent, or service-specific check.

The app is the authorization boundary because it already owns each saved host
connection. Route messages contain only opaque server ids, sanitized host
labels/status, tool names/arguments, and results. Passwords, relay keys, endpoint
configuration, and OpenAI credentials never cross from one daemon to another.
The target catalog is created without a caller agent id, so a routed request
cannot claim an agent's workspace authority or recursively acquire the hidden
Live Voice routing tools. Dropping the caller agent id also drops the
agent-to-agent defaults that come with it, including background execution, so a
routed call that asks for a report sets `defaultAgentWorkToBackground`. Without
it the tool would block, the background-start hook would never fire, and the
report the caller was promised would never be sent — a silence the model cannot
detect or recover from. A paired source daemon also cannot use the app as a
general cross-host bridge: the app accepts a route only while it owns the exact
active Live Voice session id on that source host.

Older clients that do not advertise the routing capability retain local-only
Live Voice behavior and never receive the new server-initiated route messages.

Workspace label definitions use a separate, explicitly subscribed sequence. The list request both
fetches and grants live updates for that session. A current cursor receives an empty correlated
catch-up response when nothing changed; idle sessions and unsubscribed sessions receive no label
traffic. Workspace assignments stay on the workspace directory sequence.

### `packages/cli` — Command-line client

Commander.js CLI with Docker-style commands. Common agent operations are also exposed at the top level (e.g. `paseo ls`, `paseo run`).

- `paseo agent ls/run/import/attach/logs/stop/delete/send/inspect/wait/archive/reload/update/mode`
- `paseo daemon start/stop/restart/status/pair/set-password`
- `paseo terminal ls/create/capture/send-keys/kill`
- `paseo script ls/start/stop`
- `paseo schedule create/ls/inspect/update/pause/resume/run-once/logs/delete`
- `paseo heartbeat create/update/delete`
- `paseo project create/ls/rename/delete`
- `paseo workspace create/ls/rename/archive`
- `paseo permit allow/deny/ls`
- `paseo provider ls/models`
- hidden legacy `paseo worktree create/ls/archive` compatibility alias
- `paseo speech …`

Communicates with the daemon via the same WebSocket protocol as the app.

### `packages/relay` — Relay transport and E2E encryption

Enables remote access when the daemon is behind a firewall.

- Curve25519 establishes the relay-session secret; NaCl `box` protects each payload with XSalsa20-Poly1305
- The relay is zero-knowledge — it routes encrypted bytes and cannot read content
- Client and daemon channels with identical API (`createClientChannel`, `createDaemonChannel`)
- Pairing via QR code transfers the daemon's public key to the client
- New homes keep relay disabled until pairing consent. `DaemonConfigStore` persists the desired state, while the relay runtime starts or stops the outbound transport live; pairing reads that current state instead of a startup snapshot.
- Optional E2EE capability negotiation preserves application frame kind: text plaintext uses base64 ciphertext text frames, while binary plaintext uses raw ciphertext binary frames; mixed-version peers remain base64-only
- Self-hosted relays opt into TLS with `daemon.relay.useTls` or `PASEO_RELAY_USE_TLS=true`; the public (client-facing) TLS setting can be overridden independently via `daemon.relay.publicUseTls` or `PASEO_RELAY_PUBLIC_USE_TLS`

The production relay server lives in [getpaseo/paseo-relay](https://github.com/getpaseo/paseo-relay). It is a distributed Elixir service. The Cloudflare relay implementation in this monorepo is retained as legacy code and is not deployed.

See [SECURITY.md](../SECURITY.md) for the full threat model.

### Paseo Hub

The optional Hub relationship is daemon-outbound and does not use the relay. Its connection,
authorization, ownership, persistence, and lifecycle contract is documented in [hub.md](hub.md).

### `packages/desktop` — Desktop app (Electron)

Electron wrapper for macOS, Linux, and Windows.

- Can spawn the daemon as a managed subprocess
- Native file access for workspace integration
- Same WebSocket client as mobile app

The desktop does not manage agent skills. It retains one compatibility reader for the old
`skill-selection.json`, imports that preference into its managed local daemon, then deletes the old
file after the daemon confirms persistence.

**Multi-window (hybrid land-on model).** `createWindow()` in `main.ts` is reusable: `⌘⇧N`/File→New Window, relaunching the app (`second-instance`), and the sidebar "Open in new window" action each open a fresh `BrowserWindow`. Every window shows the full sidebar — there is no per-window project ownership or filtering. "Land on a project" is delivered by a per-`webContents` `PendingOpenProjectStore`: each window pulls its own pending project path on mount (`paseo:get-pending-open-project`) and runs the normal open-project flow, identical to a CLI `paseo <path>` launch.

> **Window-state v1 limitation:** only the _first_ window of a session restores and persists saved geometry (size/position/maximized). Windows opened via ⌘⇧N / second-instance / "Open in new window" open at the default size, OS-cascaded, and do not persist — this avoids every window stacking on the same restored bounds and fighting over the single window-state store. Lifting this needs per-window state keys.
>
> **In-app browser profile.** Every browser guest uses one stable persistent Electron session, so cookies, authentication, cache, and site storage are shared across tabs, workspaces, and desktop windows and survive tab or app closure. Browser identity is independent of that storage partition: after every `did-attach`, the renderer explicitly registers its browser id, workspace id, and current guest `WebContents` id, and main accepts the registration only when that guest belongs to the calling renderer and the shared profile. Registration is intentionally repeated because reparenting a retained `<webview>` can replace its guest without replacing the DOM element. Settings > General > Clear browser data is the sole profile-deletion path; it clears the shared session and reloads live guests without deleting saved tabs or URLs.
>
> **In-app browser window opens.** Ordinary link opens, including Shift-clicked links, become Paseo workspace tabs. Script-created opens with popup features or a named window target and POST-backed opens remain secured Electron child windows in the shared browser profile, preserving `window.opener`, `postMessage`, named-window reuse, request bodies, and `window.close()` for OAuth, payment, and similar popup protocols. Unsupported URL schemes are denied before either path.
>
> **In-app browser ownership.** Each registered guest records its owning host window. The active browser is keyed by `(host window, workspace)`, and application-menu Reload / Force Reload resolve only within the window Electron supplies to the menu callback. A non-null active update must name a browser owned by that host; a null update clears only that host/workspace. Browser automation continues to target explicit browser ids returned by `browser_new_tab` or `browser_list_tabs`.
>
> **Browser keyboard boundary.** Guest pages receive renderer-published shortcuts first. `Cmd/Ctrl+L` and `Cmd/Ctrl+R` are explicit guest-shell reservations; ordinary Paseo shortcuts run only after the page declines them. The sandboxed guest preload runs in every frame so focused iframes use the same boundary, while Node integration remains disabled. Human guest input disables Electron's menu fallback for plain keys. Agent-generated keys use guest `sendInputEvent` with `skipIfUnhandled`, so an unhandled Enter stops at the guest instead of reaching the host composer. Main selects the preload; it exposes no APIs to guest pages.

```text
Human key -> guest WebContents
  |-- Cmd/Ctrl+T/L/R ----------> reserved browser-shell action
  `-- page keydown
        |-- page prevents ------> page owns it
        `-- published shortcut -> guest preload -> IPC(browserId) -> Paseo resolver

Agent browser_keypress -> guest sendInputEvent(skipIfUnhandled)
  |-- guest handles ------------> page owns it
  `-- guest does not handle ----> stop; never redispatch to the host window
```

### `packages/website` — Marketing site

TanStack Router + Cloudflare Workers. Serves paseo.sh.

## WebSocket protocol

All clients speak the same WebSocket protocol over a single connection that mixes JSON text frames and a small binary framing for terminal streams. Schemas live in `packages/protocol/src/messages.ts`.

**Handshake:**

```
Client → Server:  WSHelloMessage {
                    type: "hello",
                    clientId,
                    clientType: "mobile" | "browser" | "cli" | "mcp",
                    protocolVersion,
                    appVersion?,
                    capabilities?: { voice?, pushNotifications?, ... },
                  }
Server → Client:  status message with payload { status: "server_info",
                    serverId, hostname, version, capabilities?, features }
```

There is no dedicated welcome message; the server emits a `status` session message after accepting the hello, then begins streaming. The session stores client capabilities from the hello and rehydrates them on reconnect, so the wire boundary can ask one question: `session.supports(...)`.

**Top-level WS envelopes** are `hello`, `recording_state`, `ping`/`pong`, and `session` (which wraps the rich union of session messages).

Client liveness checks use the top-level JSON `ping`/`pong` envelope, not a session RPC or RFC6455 control ping. Current clients ping every 10 seconds, beginning one interval after connecting. The first ping claims an application-ownership lease for that physical socket, all later inbound activity renews it, and the daemon forcibly terminates the socket if the lease expires. A legacy or raw socket that never sends an application ping never enters this lease and is not closed for omitting one. Session RPC timeouts are operation failures and must not be treated as proof that the socket is dead.

Every physical send path enforces an 8 MiB outbound high-water mark, including JSON broadcasts, binary terminal frames, and the encrypted relay adapter's asynchronous queue. This sits above the terminal stream's 4 MiB soft backpressure threshold, leaving room for snapshot catch-up before the hard cutoff. JSON is serialized once per broadcast after sockets already at the limit are removed, then its exact byte length is checked for every remaining socket. A frame that would cross the limit is not sent; that physical socket is forcibly terminated without disturbing other sockets attached to the same logical session. Multiple tabs and simultaneous direct and relay paths may legitimately share a client id.

Client session RPC waits default to 60s so slow relay or mobile networks do not turn a live but delayed daemon response into a false operation failure. Keep connect timeouts, app-level grace windows, explicit diagnostic latency probes, liveness ping timers, and genuinely long-running RPCs separate from this default.

New session RPCs use dotted names with `.request` and `.response` suffixes, such as `checkout.forge.set_auto_merge.request` and `checkout.forge.set_auto_merge.response`. See [rpc-namespacing.md](rpc-namespacing.md) for the convention and migration rules for older flat RPC names.

**Notable session message types:**

- `agent_update` — Agent state changed (status, title, labels)
- `agent_stream` — New timeline event from a running agent
- `workspace_update`, `script_status_update`, `workspace_setup_progress` — Workspace state
- `agent_permission_request` / `agent_permission_resolved` — Tool-call permission flow
- `agent_deleted`, `agent_archived`, `agent_status`, `agent_list`
- `checkout_status_update`, `checkout_diff_update`, and the full `checkout_*` request/response set for git operations

Agent snapshots optionally carry the daemon-owned active turn identity, and turn lifecycle stream events
optionally carry the same `turnId`. New clients use these fields when present and normalize an old daemon's
status once at the directory boundary rather than maintaining a second activity model.

- Terminal subscribe/input/capture commands
- Voice/dictation streaming events (`dictation_stream_*`, `assistant_chunk`, `audio_output`, `transcription_result`)
- Request/response pairs for fetch, list, create, etc., correlated by `requestId`; failures use `rpc_error`

`directory_suggestions_request` is one daemon-owned filesystem search capability. The daemon
configures the same `searchDirectoryEntries` engine with a root, output format, path-query policy,
entry-kind filters, match mode, blank-query behavior, and hidden-directory traversal policy. A
request without `cwd` searches the host home for absolute project paths; a request with `cwd`
searches that workspace and returns relative entries. Clients may prepend their small host-scoped
recent-project list for bare queries, but must not parse filesystem query syntax or re-filter a
correlated daemon response. The legacy `directories` response field remains a projection of the
typed `entries` list.

**Binary frames (terminal stream protocol):**

Terminal I/O is sent as binary WebSocket frames decoded by `decodeTerminalStreamFrame` in `shared/binary-frames/terminal.ts`. The layout is:

- 1-byte opcode: `Output (0x01)`, `Input (0x02)`, `Resize (0x03)`, `Snapshot (0x04)`
- 1-byte slot: terminal slot id
- variable payload: bytes for output/input, JSON-encoded `{ rows, cols }` for resize, terminal snapshot for snapshot

Terminal PTY size is last-interacting-client-wins. A client claims the PTY size only when its terminal viewport genuinely changes size or the user focuses/taps the terminal. Passive rendering work — attaching, restoring visibility, font settling, renderer refits, or just looking at a visible terminal — must not send a resize frame. The server does not broadcast resize ownership; the resized PTY redraws through normal output, and every attached client renders that output in its own local viewport.

There is also a separate file-transfer binary frame format in the same directory, used for download/upload streams.
File downloads keep the existing `FileBegin`/`FileChunk`/`FileEnd` framing and stream 256 KiB chunks
from one stable file handle. Each transfer awaits completion of its own physical WebSocket send before
reading the next chunk; it is scoped to the requesting physical socket and does not queue unrelated
messages or transfers.

### Compatibility rules

- WebSocket schemas are append-only. Add fields, do not remove fields, and never make optional fields required.
- New wire enum values must be gated at serialization with `session.supports(CLIENT_CAPS.someCapability)`.
- `Session` stores client capabilities from the `hello` handshake and rehydrates them on reconnect, so the wire boundary can ask one question: `session.supports(...)`.

Example: adding a new enum value

```ts
// 1. Add CLIENT_CAPS.newThing = "new_thing"
// 2. Let new clients advertise it in WS hello
// 3. Keep the shared producer schema strict
// 4. Gate the new emitted value: session.supports(CLIENT_CAPS.newThing) ? "new_value" : "old_value"
```

## Agent lifecycle

The lifecycle states are defined in `shared/agent-lifecycle.ts`:

```
initializing → idle ⇄ running
        ↓       ↓        ↓
              error
                ↓
              closed
```

- `initializing` — provider session is being created
- `idle` — has a live session, awaiting the next prompt
- `running` — provider is currently producing a turn
- `error` — last attempt failed; session is still attached
- `closed` — terminal state, no live session

`ManagedAgent` is a discriminated union over those lifecycle tags. Notes:

- **AgentManager** is the source of truth for agent state and broadcasts updates to all subscribers
- Timeline sequence allocation is append-only with epochs (each run starts a new epoch). The one
  permitted in-place enrichment adds a provider message id to the manager-owned row for an accepted
  prompt; it preserves the row's sequence, content, and timestamp. Storage uses sequence numbers for
  client-side dedup; the default fetch page is 200 items.
- Timeline row `timestamp` values are canonical daemon-owned timestamps. Providers may supply original replay timestamps, but clients must not guess timestamp trust or hide time UI based on local clock heuristics.
- Events stream to connected clients in real time; correctness is backed by authoritative timeline fetches and paged-to-completion catch-up.
- Agent state persists to `$PASEO_HOME/agents/{cwd-with-dashes}/{agent-id}.json`. Timeline rows are runtime memory; provider history is the durable transcript authority and resumed agents rebuild from it. That storage path is derived from `cwd`, not from workspace id.

## Right-sidebar boundary: directory-backed vs workspace-owned

Two workspaces can share the same `cwd` (e.g. a `directory` workspace and a `local_checkout` workspace on the same folder, or several workspaces opened against one checkout). Model B keeps these distinct: they share everything the directory determines, but nothing the workspace owns. The right-sidebar surfaces split cleanly along this line, and the split is enforced purely by **what each piece of state is keyed by**.

**Directory-backed (shared by same-`cwd` workspaces) — keyed by `(serverId, cwd)`, never by `workspaceId`:**

| Surface                 | Key                                                      | Source                                                  |
| ----------------------- | -------------------------------------------------------- | ------------------------------------------------------- |
| Git status              | `checkoutStatusQueryKey(serverId, cwd)`                  | `packages/app/src/git/query-keys.ts`                    |
| Git diff                | `checkoutDiffQueryKey(serverId, cwd, mode, baseRef, ws)` | `packages/app/src/git/query-keys.ts`                    |
| Forge change request    | `checkoutPrStatusQueryKey(serverId, cwd)`                | `packages/app/src/git/query-keys.ts`                    |
| Change request timeline | `prPaneTimelineQueryKey({ serverId, cwd, prNumber })`    | `packages/app/src/git/pull-request-panel/query-keys.ts` |
| File preview content    | `["workspaceFile", serverId, cwd, path]`                 | `packages/app/src/components/file-pane.tsx`             |
| File explorer listings  | fetched via `listDirectory(workspaceRoot, path)`         | `packages/app/src/hooks/use-file-explorer-actions.ts`   |

**Workspace-owned (independent per workspace) — keyed by `workspaceId` (falling back to `cwd` only when no `workspaceId` exists):**

| State                        | Key builder / store                                | Source                                                        |
| ---------------------------- | -------------------------------------------------- | ------------------------------------------------------------- |
| Review draft comments        | `buildReviewDraftKey`                              | `packages/app/src/review/store.ts`                            |
| Working diff comparison      | `workingDiffComparisonKey` (in-memory)             | `packages/app/src/git/working-diff-comparison/state.ts`       |
| Composer attachments         | `buildWorkspaceAttachmentScopeKey`                 | `packages/app/src/attachments/workspace-attachments-store.ts` |
| File explorer nav/open state | `fileExplorer` map keyed `workspace:{workspaceId}` | `packages/app/src/hooks/use-file-explorer-actions.ts`         |
| File explorer expanded paths | `expandedPathsByWorkspace[workspaceStateKey]`      | `packages/app/src/stores/panel-store/state.ts`                |

`diff-pane.tsx` is the canonical wiring site: it passes `{ serverId, cwd }` to the git queries and `{ serverId, workspaceId, cwd }` to the draft/comparison/attachment scope keys.

**Do not "fix" the sharing away.** Re-keying a directory-backed query by `workspaceId` makes same-`cwd` workspaces diverge (two windows onto the same git tree showing different diffs). Re-keying owned state (drafts, expanded paths) by `cwd` makes them leak between distinct workspaces on the same folder. The `workspaceId`-keyed builders carry a `// workspaceId is opaque; do not parse this key back into a path.` comment — the opaque-id fallback to `cwd` exists only for old payloads without a `workspaceId`, not as a content-sharing mechanism.

One deliberate non-violation: `AgentFileExplorerState.directories`/`files` cache directory listings inside the `workspaceId`-keyed explorer map. Same-`cwd` workspaces therefore keep duplicate caches, but they can never diverge — both fetch the identical directory via `listDirectory(workspaceRoot, …)`. This is duplication, not leakage, and is left as-is.

## Agent providers

Each provider implements the `AgentClient` interface in `agent/agent-sdk-types.ts`. Provider implementations live in `agent/providers/`.

The built-in, user-facing providers are Claude Code, Codex, Copilot, OpenCode, Pi, and OMP. Additional adapters exist in the same directory for ACP-compatible agents and internal use:

| Provider           | Wraps                                | Session format                                     |
| ------------------ | ------------------------------------ | -------------------------------------------------- |
| Claude (`claude/`) | Anthropic Agent SDK                  | `~/.claude/projects/{cwd}/{session-id}.jsonl`      |
| Codex              | Codex AppServer (`codex-app-server`) | `~/.codex/sessions/{date}/rollout-{ts}-{id}.jsonl` |
| Copilot            | GitHub Copilot via ACP               | Provider-managed                                   |
| OpenCode           | OpenCode server / CLI                | Provider-managed                                   |
| Cursor             | ACP wrapper (`acp-agent`)            | Provider-managed                                   |
| Generic ACP        | ACP wrapper                          | Provider-managed                                   |
| Pi                 | Local Pi RPC process                 | Provider-managed                                   |
| Mock load test     | In-process fake                      | In-memory                                          |

All providers:

- Handle their own authentication (Paseo does not manage API keys)
- Support session resume via persistence handles
- Map tool calls to a normalized `ToolCallDetail` type
- Expose provider-specific modes (plan, default, full-access)

Providers that can accept native tool definitions should set `supportsNativePaseoTools` and read `launchContext.paseoTools`. The daemon then passes the shared Paseo tool catalog directly and removes the internal Paseo MCP server from that provider launch config. Providers that only support MCP continue to receive the same tools through the MCP fallback at `/mcp/agents`.

## Data flow: running an agent

1. Client sends `CreateAgentRequestMessage` with config (prompt, cwd, provider, model, mode)
2. Session routes to `AgentManager.create()`
3. AgentManager creates a `ManagedAgent`, initializes provider session
4. Provider runs the agent → emits `AgentStreamEvent` items
5. Events append to the agent timeline, broadcast to all subscribed clients
6. Tool calls are normalized to `ToolCallDetail` (shell, read, edit, write, search, etc.)
7. Permission requests flow: agent → server → client → user decision → server → agent

## Storage

`$PASEO_HOME` defaults to `~/.paseo`. The most important files:

```
$PASEO_HOME/
├── agents/{cwd-with-dashes}/{agent-id}.json   # Agent record
├── projects/projects.json                      # Project registry
├── projects/workspaces.json                    # Workspace registry
├── projects/icons/                             # Custom project icon images
├── schedules/                                  # Scheduled-agent definitions and runs
├── config.json                                 # Daemon config (mutable)
├── daemon-keypair.json                         # Daemon identity for relay/E2EE
├── push-tokens.json                            # Mobile push tokens
├── paseo.sock / paseo.pid                      # Local IPC socket and pidfile
└── daemon.log                                  # Daemon trace logs (rotated)
```

## Deployment models

1. **Local daemon** (default): `paseo daemon start` on `127.0.0.1:6767`
2. **Managed desktop**: Electron app spawns daemon as subprocess, and stops it again on quit so that "restart the app" is a complete reset. Settings > Host > "Keep daemon running after quit" opts out. Only a daemon the desktop started is stopped — a daemon you started yourself with `paseo daemon start` is left alone (`paseo.pid` records `desktopManaged`).
3. **Remote + relay**: Daemon behind firewall, relay bridges with E2E encryption
