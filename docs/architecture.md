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
      ┌────────────┼────────────┐
      │            │            │
┌─────▼─────┐ ┌───▼────┐ ┌────▼─────┐
│  Claude   │ │ Codex  │ │ OpenCode │
│  Agent    │ │ Agent  │ │  Agent   │
│  SDK      │ │ Server │ │          │
└───────────┘ └────────┘ └──────────┘
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
- Exposes an MCP server for agent-to-agent control
- Optionally connects outbound to a relay for remote access

All paths are under `packages/server/src/`.

**Key modules:**

| Module                          | Responsibility                                                               |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `server/bootstrap.ts`           | Daemon initialization: HTTP server, WS server, agent manager, storage, relay |
| `server/websocket-server.ts`    | WebSocket connection management, hello handshake, binary frame routing       |
| `server/session.ts`             | Per-client session state, timeline subscriptions, terminal operations        |
| `server/agent/agent-manager.ts` | Agent lifecycle state machine, timeline tracking, subscriber management      |
| `server/agent/agent-storage.ts` | File-backed JSON persistence at `$PASEO_HOME/agents/`                        |
| `server/agent/mcp-server.ts`    | MCP server for sub-agent creation, permissions, timeouts                     |
| `server/agent/providers/`       | Provider adapters (see "Agent providers" below)                              |
| `server/relay-transport.ts`     | Outbound relay connection with E2E encryption                                |
| `server/schedule/`              | Cron-based scheduled agents                                                  |
| `server/loop-service.ts`        | Looping agent runs that retry until an exit condition                        |
| `server/chat/`                  | Chat rooms for agent-to-agent and human-to-agent messaging                   |
| `client/daemon-client.ts`       | Client library for connecting to the daemon (used by CLI and app)            |
| `shared/messages.ts`            | Zod schemas for the entire wire protocol                                     |
| `shared/binary-frames/`         | Terminal stream and file transfer binary frame codecs                        |

### `packages/app` — Mobile + web client (Expo)

Cross-platform React Native app that connects to one or more daemons.

- Expo Router navigation (`/h/[serverId]/workspace/[workspaceId]`, `/h/[serverId]/agent/[agentId]`, etc.)
- `HostRuntimeController` manages saved host connections, reconnection, and per-host runtime state
- `SessionContext` wraps the daemon client for the active session
- Timeline reducers in `timeline/session-stream-reducers.ts` handle compaction, gap detection, sequence-based deduplication
- Voice features: dictation (STT) and voice agent (realtime)

### `packages/cli` — Command-line client

Commander.js CLI with Docker-style commands. Common agent operations are also exposed at the top level (e.g. `paseo ls`, `paseo run`).

- `paseo agent ls/run/import/attach/logs/stop/delete/send/inspect/wait/archive/reload/update/mode`
- `paseo daemon start/stop/restart/status/pair/set-password`
- `paseo chat ls/create/inspect/post/read/wait/delete`
- `paseo terminal ls/create/capture/send-keys/kill`
- `paseo loop run/ls/inspect/logs/stop`
- `paseo schedule create/ls/inspect/update/pause/resume/run-once/logs/delete`
- `paseo permit allow/deny/ls`
- `paseo provider ls/models`
- `paseo worktree create/ls/archive`
- `paseo speech …`

Communicates with the daemon via the same WebSocket protocol as the app.

### `packages/relay` — E2E encrypted relay

Enables remote access when the daemon is behind a firewall.

- ECDH key exchange + AES-256-GCM encryption
- Relay server is zero-knowledge — it routes encrypted bytes, cannot read content
- Client and daemon channels with identical API (`createClientChannel`, `createDaemonChannel`)
- Pairing via QR code transfers the daemon's public key to the client
- Self-hosted relays opt into TLS with `daemon.relay.useTls` or `PASEO_RELAY_USE_TLS=true`

See [SECURITY.md](../SECURITY.md) for the full threat model.

### `packages/desktop` — Desktop app (Electron)

Electron wrapper for macOS, Linux, and Windows.

- Can spawn the daemon as a managed subprocess
- Native file access for workspace integration
- Same WebSocket client as mobile app

### `packages/website` — Marketing site

TanStack Router + Cloudflare Workers. Serves paseo.sh.

## WebSocket protocol

All clients speak the same WebSocket protocol over a single connection that mixes JSON text frames and a small binary framing for terminal streams. Schemas live in `packages/server/src/shared/messages.ts`.

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

**Binary frames (terminal stream protocol):**

Terminal I/O is sent as binary WebSocket frames decoded by `decodeTerminalStreamFrame` in `shared/binary-frames/terminal.ts`. The layout is:

- 1-byte opcode: `Output (0x01)`, `Input (0x02)`, `Resize (0x03)`, `Snapshot (0x04)`
- 1-byte slot: terminal slot id
- variable payload: bytes for output/input, JSON-encoded `{ rows, cols }` for resize, terminal snapshot for snapshot

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
- Events stream to all subscribed clients in real time
- Agent state persists to `$PASEO_HOME/agents/{cwd-with-dashes}/{agent-id}.json` (timeline rows live alongside the record)

## Agent providers

Each provider implements the `AgentClient` interface in `agent/agent-sdk-types.ts`. Provider implementations live in `agent/providers/`.

The three first-class, user-facing providers are Claude Code, Codex, and OpenCode. Additional adapters exist in the same directory for ACP-compatible agents and internal use:

| Provider           | Wraps                                | Session format                                     |
| ------------------ | ------------------------------------ | -------------------------------------------------- |
| Claude (`claude/`) | Anthropic Agent SDK                  | `~/.claude/projects/{cwd}/{session-id}.jsonl`      |
| Codex              | Codex AppServer (`codex-app-server`) | `~/.codex/sessions/{date}/rollout-{ts}-{id}.jsonl` |
| OpenCode           | OpenCode server / CLI                | Provider-managed                                   |
| Cursor / Copilot   | ACP wrapper (`acp-agent`)            | Provider-managed                                   |
| Generic ACP        | ACP wrapper                          | Provider-managed                                   |
| Pi-direct          | Direct Anthropic API call            | Stateless                                          |
| Mock load test     | In-process fake                      | In-memory                                          |

All providers:

- Handle their own authentication (Paseo does not manage API keys)
- Support session resume via persistence handles
- Map tool calls to a normalized `ToolCallDetail` type
- Expose provider-specific modes (plan, default, full-access)

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
