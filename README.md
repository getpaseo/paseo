# Junction

A web-based interface for controlling AI coding agents (Claude Code, Codex, OpenCode) across one or more machines. Your dev environment, from any browser.

Junction runs a **daemon** on each machine that manages agent processes, and a **web app** (Vite SPA) that connects to daemons over WebSocket for real-time streaming.

> [!WARNING]
> **Early development** -- Features may break or change without notice.

## Architecture

```
Browser (any device)          Machine A              Machine B
  +----------------+        +------------+         +------------+
  | Junction Web   | -----> | Daemon     |         | Daemon     |
  | (Vite SPA)     |  WS    | :6767      |         | :6767      |
  +----------------+        +------------+         +------------+
         |                   | Claude Code|         | Codex      |
         +-----------------> | Codex      |         | OpenCode   |
              WS (relay)     +------------+         +------------+
```

- **Daemon** (`@junction/server`) -- Runs on your dev machine. Launches and manages agent processes, streams output over WebSocket.
- **Web App** (`@junction/app`) -- Vite SPA that connects to one or more daemons. Works on desktop and mobile browsers.
- **CLI** (`@junction/cli`) -- Docker-style commands for managing agents from the terminal.
- **Relay** (`@junction/relay`) -- Cloudflare Durable Object that bridges WebSocket connections through NAT. End-to-end encrypted.
- **Auth** (`@junction/auth`) -- Optional TOTP-based authentication server for multi-user setups.

## Prerequisites

- **Node.js** >= 20
- **npm** >= 10
- At least one AI coding agent installed on the machine running the daemon:
  - [Claude Code](https://docs.anthropic.com/en/docs/agents/claude-code) (`claude` CLI)
  - [Codex](https://github.com/openai/codex) (`codex` CLI)
  - [OpenCode](https://github.com/nicholascao/opencode) (`opencode` CLI)

Agent providers handle their own authentication. Junction does not manage API keys for agents.

---

## Single Machine Setup

The simplest setup: daemon and web app on the same machine.

### 1. Install dependencies

```bash
git clone <repo-url> junction && cd junction
npm install
```

### 2. Start the daemon

```bash
npm run dev:server
```

This starts the Junction daemon on `127.0.0.1:6767`. Runtime state is stored in `~/.junction/`.

To use a different port or home directory:

```bash
JUNCTION_LISTEN=127.0.0.1:7000 JUNCTION_HOME=~/.junction-dev npm run dev:server
```

### 3. Start the web app

In a separate terminal:

```bash
npm run dev:app
```

This starts the Vite dev server on `http://localhost:5173`.

### 4. Connect and use

1. Open **http://localhost:5173** in your browser
2. The daemon URL is pre-filled as `ws://localhost:6767/ws` -- click **Connect**
3. Set the **Working Dir** in the sidebar to your project path (e.g. `/Users/you/myproject`)
4. Select a **Provider** (Claude, Codex, or OpenCode)
5. Click **+ New Chat** and send a message

You should see the agent's response streaming in real-time, with tool calls (file reads, edits, shell commands) rendered inline.

### Using the CLI

```bash
# List all agents
npm run cli -- ls -a

# Run a new agent with a prompt
npm run cli -- run --provider claude --cwd /path/to/project "explain this codebase"

# View agent timeline
npm run cli -- logs <agent-id>

# Send a follow-up message
npm run cli -- send <agent-id> "now refactor the auth module"

# Stop an agent
npm run cli -- stop <agent-id>

# Check daemon status
npm run cli -- daemon status
```

To point the CLI at a different daemon:

```bash
npm run cli -- --host localhost:7000 ls -a
```

---

## Multi-Machine Setup

Run daemons on multiple dev machines and connect to all of them from a single browser.

### Option A: Direct Connection (Same Network)

If your machines are on the same LAN, connect directly over WebSocket.

**On each machine running agents:**

```bash
# Bind to all interfaces so other machines can reach it
JUNCTION_LISTEN=0.0.0.0:6767 npm run dev:server
```

**In the browser:**

1. Open the web app at `http://localhost:5173`
2. Connect to each daemon by IP: `ws://192.168.1.100:6767/ws`, `ws://192.168.1.101:6767/ws`
3. Switch between daemons in the sidebar

> **Security note:** Direct LAN connections are unencrypted. Only use this on trusted networks.

### Option B: Relay Connection (Across Networks / Behind NAT)

The relay bridges WebSocket connections between your browser and daemons behind NAT, with end-to-end encryption.

**On each machine running agents:**

The daemon connects to the relay automatically on startup. Each daemon gets a unique server ID stored in `~/.junction/server-id`.

```bash
# Start the daemon (relay is enabled by default)
npm run dev:server

# Check your daemon's server ID
cat ~/.junction/server-id
```

**In the browser:**

Connect using the relay URL format:

```
wss://relay.junction.sh/ws?role=client&serverId=<SERVER_ID>
```

Replace `<SERVER_ID>` with the target daemon's server ID.

The connection is end-to-end encrypted using X25519 key exchange. The relay cannot read your traffic.

**Relay configuration:**

```bash
# Disable relay (direct connections only)
JUNCTION_RELAY_ENABLED=false npm run dev:server

# Use a self-hosted relay
JUNCTION_RELAY_ENDPOINT=relay.yourdomain.com:443 npm run dev:server
```

The relay source is in `packages/relay/` and deploys to Cloudflare Workers with Durable Objects.

---

## Authentication (Optional)

Junction includes a TOTP-based auth system for multi-user setups. Without auth, anyone who can reach the daemon can connect.

### Start the auth server

```bash
npx tsx packages/auth/src/server.ts
```

Starts on port `6800`. Configure with `AUTH_PORT` and `JUNCTION_HOME` environment variables.

### Bootstrap the first admin

```bash
curl -X POST http://localhost:6800/auth/bootstrap \
  -H 'Content-Type: application/json' \
  -d '{"username": "admin"}'
```

Returns a QR code and TOTP secret. Scan with an authenticator app (Google Authenticator, Authy, 1Password, etc.). Bootstrap only works once -- after the first user is created, this endpoint is disabled.

### Log in

```bash
curl -X POST http://localhost:6800/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username": "admin", "code": "123456"}'
```

Returns a JWT token valid for 30 days.

### Create additional users

```bash
curl -X POST http://localhost:6800/auth/users \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <JWT_TOKEN>' \
  -d '{"username": "alice", "role": "user"}'
```

---

## Environment Variables

### Daemon

| Variable | Default | Description |
|---|---|---|
| `JUNCTION_HOME` | `~/.junction` | Runtime state directory (agents, keys, config) |
| `JUNCTION_LISTEN` | `127.0.0.1:6767` | Listen address (`host:port`, `/path/to/socket`, or `unix:///path`) |
| `JUNCTION_RELAY_ENABLED` | `true` | Connect to relay for NAT traversal |
| `JUNCTION_RELAY_ENDPOINT` | `relay.junction.sh:443` | Relay server address |
| `OPENAI_API_KEY` | -- | Required for Codex provider |

### Auth Server

| Variable | Default | Description |
|---|---|---|
| `AUTH_PORT` | `6800` | Auth server listen port |
| `JUNCTION_HOME` | `~/.junction` | Shared with daemon for JWT secret |
| `AUTH_DB_PATH` | `$JUNCTION_HOME/auth/auth.db` | SQLite database path |

---

## Development

```bash
npm install                # Install all workspace dependencies
npm run dev:server         # Start daemon (dev mode, hot reload)
npm run dev:app            # Start web app (Vite dev server on :5173)
npm run typecheck          # Typecheck all packages
npm run build              # Build all packages
npm run test               # Run tests
```

### Running multiple daemon instances locally

```bash
# Terminal 1
JUNCTION_HOME=~/.junction-a JUNCTION_LISTEN=127.0.0.1:6767 npm run dev:server

# Terminal 2
JUNCTION_HOME=~/.junction-b JUNCTION_LISTEN=127.0.0.1:6768 npm run dev:server
```

Connect to both from the web app to test multi-daemon workflows.

### Project structure

```
packages/
  server/     @junction/server    Daemon: agent management, WebSocket API, MCP server
  app/        @junction/app       Web app: Vite + React 19 + Tailwind SPA
  cli/        @junction/cli       CLI: Docker-style agent commands
  relay/      @junction/relay     Relay: Cloudflare Workers NAT traversal
  auth/       @junction/auth      Auth: TOTP + JWT authentication server
```

### Agent state

Agent data is stored at `$JUNCTION_HOME/agents/{cwd}/{agent-id}.json`.

```bash
find ~/.junction/agents -name "<agent-id>.json"     # Find by ID
grep -rl "search text" ~/.junction/agents/           # Find by content
```

## Supported Agents

| Provider | CLI Binary | Auth |
|---|---|---|
| Claude Code | `claude` | Anthropic account (managed by Claude) |
| Codex | `codex` | `OPENAI_API_KEY` env var |
| OpenCode | `opencode` | Provider-specific (managed by OpenCode) |

## License

MIT
