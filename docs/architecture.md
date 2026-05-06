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

**Key modules:**

| Module                    | Responsibility                                                                |
| ------------------------- | ----------------------------------------------------------------------------- |
| `bootstrap.ts`            | Daemon initialization: HTTP server, WS server, agent manager, storage, relay  |
| `websocket-server.ts`     | WebSocket connection management, hello/welcome handshake, binary multiplexing |
| `session.ts`              | Per-client session state, timeline subscriptions, terminal operations         |
| `agent/agent-manager.ts`  | Agent lifecycle state machine, timeline tracking, subscriber management       |
| `agent/agent-storage.ts`  | File-backed JSON persistence at `$PASEO_HOME/agents/`                         |
| `agent/mcp-server.ts`     | MCP server for sub-agent creation, permissions, timeouts                      |
| `providers/`              | Provider adapters: Claude (Agent SDK), Codex (AppServer), OpenCode            |
| `relay-transport.ts`      | Outbound relay connection with E2E encryption                                 |
| `client/daemon-client.ts` | Client library for connecting to the daemon (used by CLI and app)             |

### `packages/app` — Mobile + web client (Expo)

Cross-platform React Native app that connects to one or more daemons.

- Expo Router navigation (`/h/[serverId]/agents`, etc.)
- `DaemonRegistryContext` manages saved daemon connections
- `SessionContext` wraps the daemon client for the active session
- `Stream` model handles timeline with compaction, gap detection, sequence-based deduplication
- Voice features: dictation (STT) and voice agent (realtime)

### `packages/cli` — Command-line client

Commander.js CLI with Docker-style commands:

- `paseo agent ls/run/stop/logs/inspect/wait/send/attach`
- `paseo daemon start/stop/restart/status/pair`
- `paseo permit allow/deny/ls`
- `paseo provider ls/models`
- `paseo worktree ls/archive`

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

All clients speak the same binary-multiplexed WebSocket protocol.

**Handshake:**

```
Client → Server:  WSHelloMessage { id, clientId, version, timestamp }
Server → Client:  WSWelcomeMessage { clientId, daemonVersion, sessionId, capabilities }
```

**Message types:**

- `agent_update` — Agent state changed (status, title, labels)
- `agent_stream` — New timeline event from a running agent
- `workspace_update` — Workspace state changed
- `agent_permission_request` — Agent needs user approval for a tool call
- Command-response pairs for fetch, list, create, etc.

**Binary multiplexing:**

Terminal I/O and agent streaming share the same connection via `BinaryMuxFrame`:

- Channel 0: control messages
- Channel 1: terminal data
- 1-byte channel ID + 1-byte flags + variable payload

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

```
initializing → idle → running → idle (or error → closed)
                 ↑        │
                 └────────┘  (agent completes a turn, awaits next prompt)
```

- **AgentManager** tracks up to 200 timeline items per agent
- Timeline is append-only with epochs (each run starts a new epoch)
- Events stream to all subscribed clients in real time
- Agent state persists to `$PASEO_HOME/agents/{cwd-with-dashes}/{agent-id}.json`

## Agent providers

Each provider implements a common `AgentClient` interface:

| Provider | Wraps               | Session format                                     |
| -------- | ------------------- | -------------------------------------------------- |
| Claude   | Anthropic Agent SDK | `~/.claude/projects/{cwd}/{session-id}.jsonl`      |
| Codex    | CodexAppServer      | `~/.codex/sessions/{date}/rollout-{ts}-{id}.jsonl` |
| OpenCode | OpenCode CLI        | Provider-managed                                   |

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

```
$PASEO_HOME/
├── agents/{cwd-with-dashes}/{agent-id}.json   # Agent state + config
├── projects/projects.json                      # Project registry
├── projects/workspaces.json                    # Workspace registry
└── daemon.log                                  # Daemon trace logs
```

## Deployment models

1. **Local daemon** (default): `paseo daemon start` on `127.0.0.1:6767`
2. **Managed desktop**: Electron app spawns daemon as subprocess
3. **Remote + relay**: Daemon behind firewall, relay bridges with E2E encryption
