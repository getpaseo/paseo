# Unix Socket MCP Plan

## Decision recap
- Primary transport: Streamable HTTP over Unix domain socket.
- Socket path: `${PASEO_HOME}/self-id-mcp.sock`.
- Add a PID lock file in `PASEO_HOME` to prevent multiple daemons.

---

## MCP Server Split (Two Separate Servers)

We have **two distinct MCP servers** with different purposes and transports:

### 1. Agent Management MCP (for voice assistant)

**Purpose:** Managing agents from the UI/voice assistant LLM
**Transport:** In-memory (runs in-process with the voice assistant LLM)
**File:** `packages/server/src/server/agent/agent-management-mcp.ts`
**Server name:** `"paseo-agent-management"`

**Tools:**
- `create_agent` - Create a new agent
- `wait_for_agent` - Wait for agent completion or permission request
- `send_agent_prompt` - Send a task to an agent
- `get_agent_status` - Get agent snapshot
- `list_agents` - List all agents
- `cancel_agent` - Cancel current agent run
- `kill_agent` - Terminate agent permanently
- `get_agent_activity` - Get agent timeline summary
- `set_agent_mode` - Change agent session mode
- `list_pending_permissions` - List all pending permission requests
- `respond_to_permission` - Approve/deny a permission request

**No `callerAgentId` needed** - voice assistant is not an agent.

### 2. Agent Self-ID MCP (for coding agents)

**Purpose:** Agents identifying themselves (title, branch)
**Transport:** Stdio bridge → Unix socket (`${PASEO_HOME}/self-id-mcp.sock`)
**File:** `packages/server/src/server/agent/agent-self-id-mcp.ts`
**Server name:** `"paseo-agent-self-id"`

**Tools:**
- `set_title` - Set agent's display title
- `set_branch` - Rename git branch (Paseo worktrees only)

**Requires `callerAgentId`** - must know which agent is calling.

### Naming conventions

| Concept | Old name | New name |
|---------|----------|----------|
| MCP server file | `mcp-server.ts` | Split into `agent-management-mcp.ts` + `agent-self-id-mcp.ts` |
| Socket path config | `mcpSocketPath` | `selfIdMcpSocketPath` |
| Socket file | `self-id-mcp.sock` | `self-id-mcp.sock` |
| Bridge command | `paseo self-id-bridge` | `paseo self-id-bridge` |
| MCP config key | `paseo` | `paseo-self-id` |

### Architecture diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Paseo Daemon                                │
│                                                                     │
│  ┌─────────────────────────┐    ┌─────────────────────────────┐    │
│  │ Agent Management MCP    │    │ Agent Self-ID MCP           │    │
│  │ (paseo-agent-management)│    │ (paseo-agent-self-id)       │    │
│  │                         │    │                             │    │
│  │ - create_agent          │    │ - set_title                 │    │
│  │ - wait_for_agent        │    │ - set_branch                │    │
│  │ - send_agent_prompt     │    │                             │    │
│  │ - get_agent_status      │    │ Requires callerAgentId      │    │
│  │ - list_agents           │    └──────────────▲──────────────┘    │
│  │ - cancel_agent          │                   │                   │
│  │ - kill_agent            │                   │ HTTP over         │
│  │ - get_agent_activity    │                   │ Unix socket       │
│  │ - set_agent_mode        │                   │                   │
│  │ - list_pending_perms    │    ┌──────────────┴──────────────┐    │
│  │ - respond_to_permission │    │ ${PASEO_HOME}/self-id-mcp.sock │ │
│  │                         │    └──────────────▲──────────────┘    │
│  │ No callerAgentId needed │                   │                   │
│  └───────────▲─────────────┘                   │                   │
│              │                                 │                   │
└──────────────┼─────────────────────────────────┼───────────────────┘
               │                                 │
               │ In-memory                       │ stdio
               │ transport                       │
               │                                 │
┌──────────────┴──────────────┐    ┌─────────────┴─────────────────┐
│ Voice Assistant LLM         │    │ paseo self-id-bridge          │
│ (runs in daemon process)    │    │ (spawned by agent)            │
└─────────────────────────────┘    └─────────────▲─────────────────┘
                                                 │
                                                 │ stdio MCP
                                                 │
                                   ┌─────────────┴─────────────────┐
                                   │ Coding Agent                  │
                                   │ (Claude Code / Codex)         │
                                   │                               │
                                   │ MCP config:                   │
                                   │ "paseo-self-id": {            │
                                   │   "type": "stdio",            │
                                   │   "command": "paseo",         │
                                   │   "args": ["self-id-bridge",  │
                                   │     "--agent-id", "<id>"]     │
                                   │ }                             │
                                   └───────────────────────────────┘
```

### Files to create/modify

1. **Split `mcp-server.ts`:**
   - `agent-management-mcp.ts` - voice assistant tools (no callerAgentId)
   - `agent-self-id-mcp.ts` - agent self-ID tools (requires callerAgentId)

2. **Rename config/variables:**
   - `config.ts`: `mcpSocketPath` → `selfIdMcpSocketPath`
   - `bootstrap.ts`: rename socket server variables
   - `agent-manager.ts`: update MCP injection to use new names

3. **Rename CLI command:**
   - `cli.ts`: `self-id-bridge` → `self-id-bridge`

4. **Rename socket file:**
   - `self-id-mcp.sock` → `self-id-mcp.sock`

## 1. Node.js / Express: listening on Unix sockets
- Node's `net.Server.listen(path[, ...])` supports IPC servers that listen on a filesystem path, i.e., Unix domain sockets. This is the underlying primitive used by `http.Server.listen` as well. citeturn3view2
- Express explicitly documents `app.listen(path, [callback])` for Unix sockets and states it is identical to Node's `http.Server.listen()`. citeturn6view0

**Implication:** a standard Node `http.createServer()` or an Express app can bind directly to `${PASEO_HOME}/self-id-mcp.sock` without extra adapters.

## 2. MCP StreamableHTTPServerTransport over Unix sockets
- The MCP Streamable HTTP transport is defined in terms of regular HTTP POST/GET semantics and SSE responses; it's not tied to TCP. citeturn16search0
- The TypeScript SDK's Streamable HTTP transport is designed to work with standard Node HTTP servers (e.g., Express or `http.createServer`). citeturn8search4

**Inference:** because the transport only requires standard HTTP request/response objects and SSE semantics, and Node/Express can serve HTTP over Unix domain sockets, StreamableHTTPServerTransport should work unchanged over a Unix socket. citeturn3view2turn6view0turn16search0turn8search4

**Validation idea:** run the existing Streamable HTTP example server on a Unix socket and connect with an MCP client that supports custom base URLs (or a Unix-socket-aware HTTP client). If the client stack doesn't natively support UDS, add a tiny client-side adapter (e.g., `http.request({ socketPath })`).

## 3. PID lock file proposal (PASEO_HOME)

### Location
- `${PASEO_HOME}/paseo.pid` (or `${PASEO_HOME}/daemon.pid`), alongside `self-id-mcp.sock`.

### Format (JSON, single line)
Example:

```
{"pid":12345,"startedAt":"2026-01-30T12:34:56.789Z","hostname":"my-host","uid":501,"sockPath":"/path/to/self-id-mcp.sock","argv":["/path/to/paseo","--mcp"]}
```

### Acquisition algorithm (atomic)
1. Attempt to create the PID file with an exclusive create (e.g., `fs.open(path, 'wx')`).
2. If successful, write the JSON payload and close.
3. If it already exists:
   - Read and parse it.
   - Check if the PID is still alive (e.g., `process.kill(pid, 0)` in Node). If not alive, treat as stale.
   - If alive, optionally verify it's the same process by comparing `argv`/`sockPath` and start time (see below). If it matches, exit with “already running.” If it doesn't match, treat as stale or require manual cleanup.

### Stale lock detection
- **Minimum:** `process.kill(pid, 0)` to check if the PID exists. If not, delete the lock and retry.
- **Stronger:** verify start time (e.g., compare `startedAt` to OS process start time), or verify the command line matches expected values. This reduces false positives due to PID reuse.
- If the lock is stale, remove the PID file and re-acquire.

### Cleanup
- On clean shutdown: remove PID file and unlink `${PASEO_HOME}/self-id-mcp.sock`.
- On crash: lock file is cleaned on next startup by the stale-check path.

## Open questions (answered)

**Q: Should the daemon refuse to start if `PASEO_HOME` is missing, or create it?**
A: Create it. Current behavior already creates `~/.paseo` on first run.

**Q: Should the socket path be overridable via env var?**
A: Yes, `PASEO_SELF_ID_MCP_SOCK` for testing. Default: `${PASEO_HOME}/self-id-mcp.sock`.

**Q: Do we need a UDS-aware client wrapper?**
A: For the Paseo MCP injection into agents, we need to configure Claude Code's MCP client. Claude Code uses the SDK which should support `socketPath` in HTTP options. We'll test this.

---

## Implementation Plan

### Phase 1: Quick validation (do this first)
1. Modify `bootstrap.ts` to optionally listen on Unix socket instead of TCP
2. Test manually with `curl --unix-socket ~/.paseo/self-id-mcp.sock http://localhost/mcp/agents`
3. Verify MCP handshake works over socket

### Phase 2: PID lock file
1. Create `packages/server/src/server/pid-lock.ts`:
   - `acquireLock(paseoHome: string): Promise<void>` - throws if locked
   - `releaseLock(paseoHome: string): Promise<void>` - cleanup on shutdown
   - `isLocked(paseoHome: string): Promise<{ locked: boolean; pid?: number }>`
2. Call `acquireLock()` early in daemon startup (before creating server)
3. Register cleanup on SIGTERM/SIGINT and normal exit

### Phase 3: Socket file management
1. On startup: unlink stale socket file if exists (after PID check passes)
2. On shutdown: unlink socket file
3. Handle `EADDRINUSE` gracefully with helpful error message

### Phase 4: Config updates
1. Add `listen` config option supporting:
   - `host:port` (TCP, current behavior)
   - `unix:/path/to/socket` (Unix socket)
   - Default: `unix:${PASEO_HOME}/self-id-mcp.sock`
2. Keep TCP as optional fallback via `PASEO_LISTEN=host:port`

### Phase 5: Agent MCP injection (the original bug)
1. For UI agents, inject MCP server config with socket path
2. Format for Claude Code MCP config:
   ```json
   {
     "paseo": {
       "type": "http",
       "url": "http://localhost/mcp/agents",
       "socketPath": "/Users/foo/.paseo/self-id-mcp.sock"
     }
   }
   ```
3. Need to verify Claude Code SDK supports `socketPath` option

---

## Files to modify

1. `packages/server/src/server/pid-lock.ts` (new)
2. `packages/server/src/server/config.ts` - add socket config
3. `packages/server/src/server/bootstrap.ts` - socket listening + PID lock
4. `packages/server/src/server/agent/agent-manager.ts` - inject MCP for UI agents
5. `packages/server/src/server/agent/agent-sdk-types.ts` - add `paseoMcpSocketPath` to config

---

## Testing checklist
- [ ] Daemon starts and listens on Unix socket
- [ ] `curl --unix-socket` can reach MCP endpoint
- [ ] Second daemon start fails with "already running" error
- [ ] Stale PID file is cleaned up automatically
- [ ] Socket file is cleaned up on shutdown
- [ ] UI agents get MCP server injected
- [ ] Agents can call `set_title` successfully

## Claude Code MCP Client Research

### Does Claude Code support `socketPath` for HTTP MCP?
- **Docs-only answer:** no. Claude Code’s MCP docs and examples show HTTP servers configured with `type: "http"` + `url` (and optional `headers`) only. There is no documented `socketPath` field anywhere in the MCP config examples. citeturn4view0
- The CLI command for HTTP MCP also only accepts a URL: `claude mcp add --transport http <name> <url>`. No socket path or Unix socket option is documented. citeturn3view0

**Conclusion:** There is no documented support for `socketPath` in Claude Code’s MCP HTTP configuration. If we require Unix sockets, we likely need a stdio bridge or a local TCP/UDS proxy.

### Does Claude Code use `@modelcontextprotocol/sdk` under the hood?
- **Not confirmed in public docs.** The Claude Code MCP docs describe configuration and usage but do not mention which SDK is used internally. citeturn3view0turn4view0
- The npm package for `@anthropic-ai/claude-code` does not list dependencies in `npm view`, which suggests it may be shipped as a bundled binary or otherwise not easily inspectable for SDK usage. (Local check; no public citation.)

### How to configure MCP in Claude Code / Claude Desktop configs
- Claude Code docs show MCP server configuration entries with `type: "http"` and `url` (optional `headers`) in the MCP config examples. citeturn4view0
- Claude Desktop config examples use `mcpServers` with `type: "stdio"` and `command`/`args`. No socket path support is shown. citeturn4view0

**Implication for Paseo:** If we stick to Unix sockets, we need a stdio bridge. Claude Code will spawn the bridge as a stdio MCP server, and the bridge forwards to the daemon over Unix socket.

---

## Revised Architecture: Stdio Bridge

Since Claude Code doesn't support `socketPath`, we need:

```
Claude Code Agent
   |
   | stdio (MCP standard - Claude Code spawns the bridge)
   v
paseo-self-id-bridge (small Node script)
   |
   | HTTP over Unix socket (${PASEO_HOME}/self-id-mcp.sock)
   v
Paseo Daemon (long-running)
```

### Bridge requirements
1. **Spawned by Claude Code** via stdio MCP config
2. **Reads JSON-RPC from stdin**, forwards to daemon over Unix socket HTTP
3. **Reads HTTP responses**, writes JSON-RPC to stdout
4. **Passes `callerAgentId`** via query param or header
5. **Handles SSE** for streaming responses (if needed)

### Claude Code MCP config for bridge
```json
{
  "paseo": {
    "type": "stdio",
    "command": "node",
    "args": ["/path/to/paseo-self-id-bridge.js", "--socket", "/Users/foo/.paseo/self-id-mcp.sock", "--agent-id", "AGENT_ID"]
  }
}
```

### Bridge implementation options
1. **Standalone script** in `packages/server/scripts/paseo-self-id-bridge.ts`
2. **CLI subcommand**: `paseo self-id-bridge --socket <path> --agent-id <id>`
3. **Bundled with CLI** so it's available wherever paseo is installed

### Revised implementation phases

**Phase 1: Unix socket for daemon** (still do this)
- Daemon listens on `${PASEO_HOME}/self-id-mcp.sock`
- PID lock file for single-instance

**Phase 2: Stdio bridge**
- Create `packages/server/src/self-id-bridge.ts`
- Bridge reads stdio, forwards to Unix socket, returns responses
- Test manually with `echo '{"jsonrpc":"2.0",...}' | node self-id-bridge.js`

**Phase 3: Agent MCP injection**
- For UI agents, inject stdio MCP config pointing to bridge
- Pass `callerAgentId` as argument to bridge
- Bridge includes it in HTTP requests to daemon

## Stdio Bridge Design

### 1) Message flow (stdio MCP)
- MCP stdio is newline-delimited JSON-RPC over stdin/stdout. Each line is a complete JSON-RPC request/notification/response (or batch), and messages MUST NOT contain embedded newlines. The server MUST NOT write non-MCP data to stdout; stderr is for logs. citeturn0search1turn0search2turn0search3
- Claude Code is the MCP client; the bridge is the MCP server on stdio. The bridge should treat JSON-RPC payloads as opaque envelopes and avoid interpreting MCP methods beyond transport concerns.

### 2) HTTP forwarding (stdio → Streamable HTTP)
- Streamable HTTP uses HTTP POSTs for client-to-server messages; responses can be JSON or SSE streams. citeturn1search3
- For each inbound stdio message, the bridge issues a POST to the daemon MCP endpoint (e.g., `http://localhost/mcp/agents`) with:
  - `Content-Type: application/json`
  - `MCP-Protocol-Version: <negotiated>` on all non-initialize requests (use the version negotiated during initialize). citeturn1search1
  - `MCP-Session-Id` once established (see session management). citeturn1search1
- If the HTTP response is JSON, emit it verbatim as a single line to stdout.

### 3) SSE handling (HTTP → stdio)
- When the HTTP response is `text/event-stream`, the bridge must parse SSE events and write each `data:` payload (a JSON-RPC message) to stdout as its own newline-delimited JSON line. citeturn1search3
- Preserve event order. Apply backpressure: if stdout is blocked, pause the HTTP/SSE reader.

### 4) Session management
- The daemon may return `MCP-Session-Id` on the HTTP response to `initialize`. The bridge must store it and include it on all subsequent HTTP requests. citeturn1search1
- If the daemon responds 404 to a request containing a session ID, the bridge MUST start a new session by sending a new initialize without the session header, then retry the original request once. citeturn1search1
- The bridge SHOULD send HTTP DELETE with `MCP-Session-Id` on shutdown to terminate the session (if supported). citeturn1search1

### 5) Error handling & failure modes
- **Daemon down / socket missing / connection refused:** return JSON-RPC error `-32603` (Internal error) with a clear message like “Paseo daemon unreachable,” and log details to stderr. citeturn0search0
- **Malformed JSON on stdin:** return JSON-RPC parse error `-32700` (id = null), log the raw line to stderr, and continue. citeturn0search0
- **HTTP 400 for missing session after initialize:** treat as bug; log and reinitialize once.
- **SSE stream drop mid-response:** surface a JSON-RPC error for the in-flight request and reconnect by reinitializing.

### 6) SDK utilities we can reuse
- The TypeScript SDK includes **StdioServerTransport**, which already implements stdin/stdout framing for MCP servers. We can reuse it for the bridge’s stdio side. citeturn2search0
- The MCP docs show **HttpClientTransport** for Streamable HTTP clients; the bridge could instantiate an SDK Client with this transport and forward stdio messages through the client (or implement a thin transport-level proxy). citeturn1search3

**Suggested implementation shape (bridge):**
1. Start a `StdioServerTransport`-based MCP server that accepts raw JSON-RPC messages.
2. For each message line, forward it via HTTP POST to the daemon (using `http.request({ socketPath })`).
3. If response is JSON, emit line. If SSE, emit each event’s `data` line.
4. Maintain `MCP-Session-Id` and protocol version headers across requests.
