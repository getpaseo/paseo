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

| Module                          | Responsibility                                                                |
| ------------------------------- | ----------------------------------------------------------------------------- |
| `server/bootstrap.ts`           | Daemon initialization: HTTP server, WS server, agent manager, storage, relay  |
| `server/websocket-server.ts`    | WebSocket connection management, hello handshake, binary frame routing        |
| `server/session.ts`             | Per-client session state, timeline subscriptions, terminal operations         |
| `server/agent/agent-manager.ts` | Agent lifecycle state machine, timeline tracking, subscriber management       |
| `server/agent/agent-storage.ts` | File-backed JSON persistence at `$PASEO_HOME/agents/`                         |
| `server/agent/tools/`           | Transport-neutral catalog for workspaces, agents, permissions, and automation |
| `server/agent/mcp-server.ts`    | Thin MCP adapter that registers the Paseo tool catalog with the MCP SDK       |
| `server/agent/providers/`       | Provider adapters (see "Agent providers" below)                               |
| `server/relay-transport.ts`     | Outbound relay connection with E2E encryption                                 |
| `server/schedule/`              | Cron-based scheduled agents                                                   |
| `server/loop-service.ts`        | Looping agent runs that retry until an exit condition                         |
| `server/chat/`                  | Chat rooms for agent-to-agent and human-to-agent messaging                    |

### `packages/protocol` — Wire schemas and shared protocol types

The source of truth for WebSocket messages, binary frame codecs, endpoint parsing,
agent timeline types, provider config schemas, and other values shared by daemon
and clients. Server, app, CLI, and `@getpaseo/client` all depend on this package;
it does not depend on the server.

### `packages/client` — Daemon client library and SDK facade

Owns the low-level daemon WebSocket driver plus the higher-level `PaseoClient`
facade. App and CLI may import the low-level driver from
`@getpaseo/client/internal/daemon-client` during migration, while new SDK-shaped
code imports from `@getpaseo/client`. Node automation uses
`@getpaseo/client/node`, which owns daemon discovery, authentication, transport
selection, and the capability-gated host automation facade shared by the CLI and
published import tools.

### External project import

The private [`getpaseo/import`](https://github.com/getpaseo/import) repository publishes
`@getpaseo/import`. It owns source discovery, parsing, mapping, fixtures, the CLI, and the
programmatic import engine. Paseo Desktop pins an exact package version and calls its library
entrypoint from Electron main, passing the public Node host-automation facade and forwarding typed
progress events through a narrow IPC bridge. Paseo does not contain source databases, parsers, or
import-package release machinery.

### `packages/app` — Mobile + web client (Expo)

Cross-platform React Native app that connects to one or more daemons.

- Expo Router navigation (`/h/[serverId]/workspace/[workspaceId]`, `/h/[serverId]/agent/[agentId]`, etc.). The `workspaceId` URL segment is an opaque workspace id, not a directly meaningful filesystem path.
- `HostRuntimeController` manages saved host connections, reconnection, and per-host runtime state
- `runtime/replica-cache` keeps a non-authoritative per-host display replica in AsyncStorage: only the last focused agent, its workspace, and a short timeline tail. It restores before navigation becomes ready, leaves remote hydration flags false, and is atomically replaced by the normal snapshot-plus-delta synchronization path.
- `SessionContext` wraps the daemon client for the active session
- Composer UI and submit/draft behavior live in `packages/app/src/composer/`; screens and panels should integrate it from there instead of dropping composer internals into `components/`, `hooks/`, or `screens/workspace/`
- Timeline reducers in `timeline/session-stream-reducers.ts` handle compaction, gap detection, sequence-based deduplication
- Timeline sync correctness is documented in [docs/timeline-sync.md](timeline-sync.md): live streams are for immediacy, `fetch_agent_timeline_request` is authoritative, and catch-up is paged but complete.
- Voice features: dictation (STT) and voice agent (realtime)

The replica cache exists only to paint stale data immediately while the host connects. It does not
own mutations, infer deletions, or replace daemon reconciliation. Pending permission requests are
not restored from it. AsyncStorage is not encrypted, so the cached timeline tail may contain source
code, prompts, and tool output; encrypted-at-rest storage is a separate product/security decision.
Its serialized payload has a 1 MiB byte budget and evicts whole host snapshots in least-recently-
written order; a single oversized host is omitted rather than partially restored.

### `packages/cli` — Command-line client

Commander.js CLI with Docker-style commands. Common agent operations are also exposed at the top level (e.g. `paseo ls`, `paseo run`).

- `paseo agent ls/run/import/attach/logs/stop/delete/send/inspect/wait/archive/reload/update/mode`
- `paseo daemon start/stop/restart/status/pair/set-password`
- `paseo chat ls/create/inspect/post/read/wait/delete`
- `paseo terminal ls/create/capture/send-keys/kill`
- `paseo loop run/ls/inspect/logs/stop`
- `paseo schedule create/ls/inspect/update/pause/resume/run-once/logs/delete`
- `paseo heartbeat create/update/delete`
- `paseo workspace create/ls/archive`
- `paseo permit allow/deny/ls`
- `paseo provider ls/models`
- hidden legacy `paseo worktree create/ls/archive` compatibility alias
- `paseo speech …`

Communicates with the daemon via the same WebSocket protocol as the app.

### `packages/relay` — E2E encrypted relay

Enables remote access when the daemon is behind a firewall.

- Curve25519 ECDH key exchange + XSalsa20-Poly1305 (NaCl `box`) encryption
- Relay server is zero-knowledge — it routes encrypted bytes, cannot read content
- Client and daemon channels with identical API (`createClientChannel`, `createDaemonChannel`)
- Pairing via QR code transfers the daemon's public key to the client
- Self-hosted relays opt into TLS with `daemon.relay.useTls` or `PASEO_RELAY_USE_TLS=true`; the public (client-facing) TLS setting can be overridden independently via `daemon.relay.publicUseTls` or `PASEO_RELAY_PUBLIC_USE_TLS`

See [SECURITY.md](../SECURITY.md) for the full threat model.

### Paseo Hub

The optional Hub relationship is daemon-outbound and does not use the relay. Its connection,
authorization, ownership, persistence, and lifecycle contract is documented in [hub.md](hub.md).

### `packages/desktop` — Desktop app (Electron)

Electron wrapper for macOS, Linux, and Windows.

- Can spawn the daemon as a managed subprocess
- Native file access for workspace integration
- Same WebSocket client as mobile app

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

Client liveness checks use the top-level JSON `ping`/`pong` envelope, not a session RPC and not RFC6455 protocol ping. The app runs through browser and React Native WebSocket APIs, which do not expose protocol ping, so this envelope is the portable way to test the direct or relay data path. Session RPC timeouts are operation failures and must not be treated as proof that the socket is dead.

Client session RPC waits default to 60s so slow relay or mobile networks do not turn a live but delayed daemon response into a false operation failure. Keep connect timeouts, app-level grace windows, explicit diagnostic latency probes, liveness ping timers, and genuinely long-running RPCs separate from this default.

New session RPCs use dotted names with `.request` and `.response` suffixes, such as `checkout.forge.set_auto_merge.request` and `checkout.forge.set_auto_merge.response`. See [rpc-namespacing.md](rpc-namespacing.md) for the convention and migration rules for older flat RPC names.

**Notable session message types:**

- `agent_update` — Agent state changed (status, title, labels)
- `agent_stream` — New timeline event from a running agent
- `workspace_update`, `script_status_update`, `workspace_setup_progress` — Workspace state
- `agent_permission_request` / `agent_permission_resolved` — Tool-call permission flow
- `agent_deleted`, `agent_archived`, `agent_status`, `agent_list`
- `checkout_status_update`, `checkout_diff_update`, and the full `checkout_*` request/response set for git operations
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
- Timeline is append-only with epochs (each run starts a new epoch). Storage uses sequence numbers for client-side dedup; the default fetch page is 200 items
- Timeline row `timestamp` values are canonical daemon-owned timestamps. Providers may supply original replay timestamps, but clients must not guess timestamp trust or hide time UI based on local clock heuristics.
- Events stream to connected clients in real time; correctness is backed by authoritative timeline fetches and paged-to-completion catch-up.
- Agent state persists to `$PASEO_HOME/agents/{cwd-with-dashes}/{agent-id}.json` (timeline rows live alongside the record). That storage path is derived from `cwd`, not from workspace id.

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
| Review draft comments        | `buildReviewDraftKey` / `buildReviewDraftScopeKey` | `packages/app/src/review/store.ts`                            |
| Diff mode override           | review-draft scope key (in-memory)                 | `packages/app/src/review/state.ts`                            |
| Composer attachments         | `buildWorkspaceAttachmentScopeKey`                 | `packages/app/src/attachments/workspace-attachments-store.ts` |
| File explorer nav/open state | `fileExplorer` map keyed `workspace:{workspaceId}` | `packages/app/src/hooks/use-file-explorer-actions.ts`         |
| File explorer expanded paths | `expandedPathsByWorkspace[workspaceStateKey]`      | `packages/app/src/stores/panel-store/state.ts`                |

`diff-pane.tsx` is the canonical wiring site: it passes `{ serverId, cwd }` to the git queries and `{ serverId, workspaceId, cwd }` to the draft/override/attachment scope keys.

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
├── agents/{cwd-with-dashes}/{agent-id}.json   # Agent record + persisted timeline rows
├── projects/projects.json                      # Project registry
├── projects/workspaces.json                    # Workspace registry
├── chat/                                       # Chat rooms
├── schedules/                                  # Scheduled-agent definitions and runs
├── loops/                                      # Loop runs and logs
├── config.json                                 # Daemon config (mutable)
├── daemon-keypair.json                         # Daemon identity for relay/E2EE
├── push-tokens.json                            # Mobile push tokens
├── paseo.sock / paseo.pid                      # Local IPC socket and pidfile
└── daemon.log                                  # Daemon trace logs (rotated)
```

## Deployment models

1. **Local daemon** (default): `paseo daemon start` on `127.0.0.1:6767`
2. **Managed desktop**: Electron app spawns daemon as subprocess
3. **Remote + relay**: Daemon behind firewall, relay bridges with E2E encryption
