# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Voice-dev is a voice-controlled development environment consisting of three interconnected services:

1. **Web UI** (Next.js) - LiveKit-based voice interface for initiating voice chats
2. **Voice Agent** (Python/LiveKit) - Coordinates TTS/STT/LLM with MCP tool access
3. **MCP Server** (Node.js/TypeScript) - Provides tmux control tools to the voice agent

All three services must be running for the system to function. The web UI connects users to LiveKit rooms where the voice agent (running on the user's machine) joins and provides voice interaction with terminal control capabilities via MCP.

## Architecture

### Component Flow

```
User Browser (Web UI)
    ↓ LiveKit WebRTC
LiveKit Cloud Infrastructure
    ↓ LiveKit Protocol
Voice Agent (Python)
    ↓ MCP HTTP
MCP Server (tmux tools)
    ↓ tmux commands
Terminal Environment
```

### Key Technologies

- **LiveKit**: Voice infrastructure (WebRTC, STT/TTS/LLM coordination)
- **MCP (Model Context Protocol)**: Tool interface between agent and terminal
- **tmux**: Terminal multiplexer for executing commands
- **Next.js 15**: Web UI framework
- **Python 3.10+**: Voice agent runtime
- **TypeScript/Node.js**: MCP server runtime

## Development Setup

### Prerequisites

- Node.js (for web and MCP server)
- Python 3.10+ with uv package manager
- tmux installed and running
- LiveKit account with API credentials

### Initial Setup

```bash
# Install root dependencies
npm install

# Install web dependencies
cd packages/web && npm install

# Install MCP server dependencies
cd packages/mcp-server && npm install

# Install agent dependencies (uses uv)
cd packages/agent-python
# Dependencies managed by uv, see pyproject.toml
```

### Environment Configuration

**Web UI** (`packages/web/.env.local`):

```
OPENAI_API_KEY=sk-...  # For legacy OpenAI Realtime API support
AUTH_PASSWORD=...      # Password to access the web UI
MCP_SERVER_URL=...     # Optional, for connecting to MCP server
```

**Voice Agent** (`packages/agent-python/.env`):

```
LIVEKIT_URL=wss://...
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
MCP_SERVER_URL=http://localhost:6767  # Local MCP server
```

**MCP Server**: Configured via command-line arguments (see below)

## Running the Services

### Start All Services (Development)

You need three terminal sessions/tmux panes:

```bash
# Terminal 1: MCP Server
cd packages/mcp-server
npm run dev  # Starts HTTP MCP server on port 6767 with password 'dev-password'

# Terminal 2: Voice Agent
cd packages/agent-python
uv run python agent.py dev  # Starts LiveKit agent worker

# Terminal 3: Web UI
cd packages/web
npm run dev  # Starts Next.js on http://localhost:3000
```

### Alternative: Use root scripts

```bash
# From repository root:
npm run dev           # Starts web UI only
npm run dev:agent     # Starts voice agent
npm run dev:mcp       # Starts MCP server
```

### Testing Individual Components

```bash
# Test MCP server
cd packages/mcp-server
npm run typecheck
npm run build

# Test web UI
cd packages/web
npm run build
npm run typecheck

# No explicit tests for agent currently
```

## Key File Locations

### Web UI (`packages/web/`)

- `app/page.tsx` - Entry point (renders VoiceClient)
- `app/voice-client.tsx` - Main voice interface component
- `app/hooks/use-livekit-voice.ts` - LiveKit connection management
- `app/api/session/route.ts` - Generates LiveKit participant tokens
- `app/components/` - UI components (mute button, volume bar, activity log, etc.)

### Voice Agent (`packages/agent-python/`)

- `agent.py` - Complete agent implementation (entrypoint, system prompt, MCP setup)
- `pyproject.toml` - Python dependencies (uses uv)
- `.env` - LiveKit and MCP configuration

### MCP Server (`packages/mcp-server/`)

- `src/index.ts` - MCP server setup, tool/resource definitions
- `src/tmux.ts` - tmux interaction primitives
- `src/http-server.ts` - HTTP transport for MCP (enables remote agent access)

## MCP Server Details

### Available MCP Tools

The MCP server exposes these tools to the voice agent:

- **list** - List tmux sessions/windows/panes (hierarchical)
- **capture-pane** - Capture terminal output from a pane
- **create-session/create-window/split-pane** - Create new tmux resources
- **rename-window** - Rename a window
- **kill** - Kill sessions/windows/panes
- **send-keys** - Send special keys (Enter, Escape, Ctrl-C, etc.)
- **send-text** - Type text into a pane (primary way to run shell commands)
- **execute-shell-command** - Run a command synchronously with timeout

### MCP Server Modes

The server supports two transport modes:

1. **stdio** (default): For local MCP clients

   ```bash
   npm run dev:stdio
   ```

2. **HTTP**: For remote agents (used by LiveKit agent)
   ```bash
   npm run dev  # HTTP on port 6767 with password 'dev-password'
   # Or:
   tsx src/index.ts --http --password <password> --port <port>
   ```

## Voice Agent System Prompt

The agent's system prompt is embedded in `packages/agent-python/agent.py`. It instructs the agent to:

- Acknowledge requests verbally before acting (critical for voice UX)
- Report tool execution results back to the user
- Handle voice-to-text errors gracefully
- Be concise for mobile users
- Work with Claude Code running in tmux sessions
- Understand tmux/git/gh CLI workflows

The prompt is comprehensive (~500 lines) and defines the agent's personality and behavior patterns.

## Common Development Tasks

### Adding a New MCP Tool

1. Define the tool in `packages/mcp-server/src/index.ts`:

   ```typescript
   server.tool(
     "tool-name",
     "Description",
     {
       /* schema */
     },
     async (params) => {
       // Implementation
     }
   );
   ```

2. Add underlying tmux primitives to `src/tmux.ts` if needed

3. Rebuild and restart the MCP server

### Modifying the Voice Agent Behavior

1. Edit `SYSTEM_PROMPT` in `packages/agent-python/agent.py`
2. Restart the agent (uv run python agent.py dev)

### Updating Web UI Components

1. Components are in `packages/web/app/components/`
2. Hooks for LiveKit integration in `packages/web/app/hooks/`
3. Use `npm run dev` in packages/web for hot reload

### TypeScript Changes

Run typecheck across all packages:

```bash
npm run typecheck  # Root command, checks all workspaces
```

## Important Notes

### LiveKit Inference vs OpenAI Realtime API

The system recently migrated from OpenAI's Realtime API to LiveKit. The codebase contains legacy references to OpenAI's API (e.g., in README.md, some hooks). The current implementation uses:

- **STT**: AssemblyAI Universal Streaming
- **LLM**: OpenAI GPT-4.1-mini (via LiveKit Inference)
- **TTS**: Cartesia Sonic 2

LiveKit Inference handles API key management for all providers, so individual provider keys are not needed in the agent config.

### MCP HTTP Transport Authentication

The MCP server in HTTP mode requires a password parameter. The agent must include this in the `MCP_SERVER_URL`:

```
MCP_SERVER_URL=http://dev-password@localhost:6767
```

### Mobile Development

The web UI requires HTTPS for microphone access on mobile devices. Use Cloudflare Tunnel, ngrok, or Tailscale for mobile testing (see packages/web/README.md).

### Workspace Structure

This is an npm workspace (see root `package.json`). All packages share the same `node_modules` at the root. Python agent uses separate virtual environment managed by uv.

## Build and Release

```bash
# Build all packages
npm run build

# Build specific packages
npm run build:web
npm run build:mcp
npm run build:agent  # No-op currently

# MCP server release
cd packages/mcp-server
npm run check-release  # Dry run
npm run release        # Publish to npm
```

## Debugging Tips

- **MCP Server**: Check HTTP server logs for incoming tool calls
- **Voice Agent**: Look for console output showing MCP server connection status
- **Web UI**: Check browser console for LiveKit connection events
- **LiveKit Connection**: Verify `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` are correct
- **MCP Connection**: Verify `MCP_SERVER_URL` includes password and is accessible from agent

## Documentation Files

Several markdown files document specific aspects:

- `packages/web/README.md` - Web UI setup and usage
- `packages/web/IMPLEMENTATION_PLAN.md` - Original OpenAI Realtime API implementation details
- `packages/web/MCP_INTEGRATION.md` - MCP integration research and decisions
- `packages/web/AUDIO_VISUALIZATION_PLAN.md` - Audio visualization feature planning
