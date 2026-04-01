---
applyTo: "packages/**"
---

# Architecture

## System overview

Paseo is a **local-first** client-server system. The daemon runs on the developer's machine, manages AI agent processes, and streams output over WebSocket. Clients connect to observe and control agents.

```
┌──────────────┐    ┌──────────┐    ┌─────────────┐
│  Mobile App  │    │   CLI    │    │ Desktop App │
│   (Expo)     │    │(Commander│    │ (Electron)  │
└──────┬───────┘    └────┬─────┘    └──────┬──────┘
       │                 │                 │
       │  WebSocket      │  WebSocket      │  Managed subprocess
       │ (direct/relay)  │  (direct)       │  + WebSocket
       └─────────────────┴─────────────────┘
                         │
                  ┌──────▼──────┐
                  │   Daemon    │
                  │  (Node.js)  │         $PASEO_HOME/daemon.log
                  └──────┬──────┘
                         │
            ┌────────────┼────────────┐
      ┌─────▼─────┐ ┌───▼────┐ ┌────▼─────┐
      │  Claude   │ │ Codex  │ │ OpenCode │
      │ Agent SDK │ │AppSrvr │ │   CLI    │
      └───────────┘ └────────┘ └──────────┘
```

## Package responsibilities

### `packages/server` — The daemon

The heart of Paseo. A Node.js process that:

- Listens for WebSocket connections from clients
- Manages agent lifecycle (create → run → idle → stop/error → closed)
- Streams agent output in real time via a timeline model (up to 200 items per agent)
- Exposes an MCP server for agent-to-agent control
- Optionally connects outbound to a relay for remote access

**Key modules:**

| Module | Responsibility |
|---|---|
| `bootstrap.ts` | Daemon init: HTTP server, WS server, agent manager, storage, relay |
| `websocket-server.ts` | WS connection management, hello/welcome handshake, binary multiplexing |
| `session.ts` | Per-client session state, timeline subscriptions, terminal operations |
| `agent/agent-manager.ts` | Agent lifecycle state machine, timeline tracking, subscriber fan-out |
| `agent/agent-storage.ts` | File-backed JSON persistence at `$PASEO_HOME/agents/` |
| `agent/mcp-server.ts` | MCP server for sub-agent creation, permissions, timeouts |
| `providers/` | Provider adapters: Claude (Agent SDK), Codex (AppServer), OpenCode |
| `relay-transport.ts` | Outbound relay connection with E2E encryption |
| `client/daemon-client.ts` | Shared client library used by CLI and app |

### `packages/app` — Expo client

Cross-platform React Native (iOS, Android, web):

- Expo Router navigation (`/h/[serverId]/agents`, etc.)
- `DaemonRegistryContext` manages saved daemon connections
- `SessionContext` wraps the daemon client for the active session
- `Stream` model handles timeline with compaction, gap detection, sequence-based deduplication
- Voice features: dictation (STT) and realtime voice agent

### `packages/cli` — Command-line client

Commander.js, Docker-style commands:

```
paseo agent ls/run/stop/logs/inspect/wait/send/attach
paseo daemon start/stop/restart/status/pair
paseo permit allow/deny/ls
paseo provider ls/models
paseo worktree ls/archive
```

Uses the same WebSocket protocol as the app via `daemon-client.ts`.

### `packages/relay` — E2E encrypted relay

Enables remote access when the daemon is behind a firewall:

- ECDH key exchange + AES-256-GCM encryption
- Relay server is zero-knowledge: it routes encrypted bytes only
- Symmetric API: `createClientChannel` and `createDaemonChannel`
- Pairing via QR code transfers the daemon's public key to the client

### `packages/desktop` — Electron wrapper

- Can spawn the daemon as a managed subprocess
- Native file system access
- Same WebSocket client as the mobile/web app

### `packages/website` — Marketing site

TanStack Router + Cloudflare Workers serving paseo.sh.

## WebSocket protocol

All clients use the same binary-multiplexed protocol.

**Handshake:**

```
Client → Server:  WSHelloMessage   { id, clientId, version, timestamp }
Server → Client:  WSWelcomeMessage { clientId, daemonVersion, sessionId, capabilities }
```

**Message types:**

| Message | Direction | Purpose |
|---|---|---|
| `agent_update` | S→C | Agent state changed (status, title, labels) |
| `agent_stream` | S→C | New timeline event from a running agent |
| `workspace_update` | S→C | Workspace state changed |
| `agent_permission_request` | S→C | Agent needs user approval for a tool call |
| Command/response pairs | C↔S | fetch, list, create, etc. |

**Binary multiplexing (`BinaryMuxFrame`):**

- Channel 0: control messages
- Channel 1: terminal data
- Frame = 1-byte channel ID + 1-byte flags + variable payload

## Agent lifecycle

```
initializing → idle → running → idle
                         │
                         └→ error → closed
```

- Timeline is append-only; each new run starts a new epoch
- Events broadcast in real time to all subscribed clients
- State persists to `$PASEO_HOME/agents/{cwd-with-dashes}/{agent-id}.json`

## Agent providers

Each provider implements the common `AgentClient` interface:

| Provider | Wraps | Session persistence |
|---|---|---|
| Claude | Anthropic Agent SDK | `~/.claude/projects/{cwd}/{session-id}.jsonl` |
| Codex | CodexAppServer | `~/.codex/sessions/{date}/rollout-{ts}-{id}.jsonl` |
| OpenCode | OpenCode CLI | Provider-managed |

All providers:
- Handle their own authentication (Paseo never manages API keys)
- Support session resume via persistence handles
- Map tool calls to a normalized `ToolCallDetail` type
- Expose provider-specific modes (plan, default, full-access)

## Data flow: running an agent

1. Client sends `CreateAgentRequestMessage` (prompt, cwd, provider, model, mode)
2. `Session` routes to `AgentManager.create()`
3. `AgentManager` creates a `ManagedAgent`, initializes provider session
4. Provider runs the agent → emits `AgentStreamEvent` items
5. Events append to agent timeline, broadcast to all subscribed clients
6. Tool calls normalized to `ToolCallDetail` (shell, read, edit, write, search, …)
7. Permission flow: agent → server → client → user decision → server → agent

## Storage layout

```
$PASEO_HOME/
├── agents/{cwd-with-dashes}/{agent-id}.json   # Agent state + config
├── projects/projects.json                      # Project registry
├── projects/workspaces.json                    # Workspace registry
└── daemon.log                                  # Full daemon trace logs
```

## Daemon port

Default: `127.0.0.1:6767`. **Do not restart the daemon without explicit permission** — it manages all running agents.
