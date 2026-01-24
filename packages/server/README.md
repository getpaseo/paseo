# Voice Assistant

A voice-controlled terminal assistant that runs as a single local service.

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env
# Edit .env and add your API keys (OpenAI, Deepgram)

# Run development servers
npm run dev

# Open browser to http://localhost:5173
```

## Architecture

- **Express Server** (port 3000) - Serves API and built UI in production
- **Vite Dev Server** (port 5173) - Hot-reload React UI in development
- **WebSocket** (`/ws`) - Real-time bidirectional communication
- **Agent** - STT → LLM → TTS pipeline with terminal control
- **Daemon** - tmux-based terminal management (in-process)

## Development

```bash
# Run both servers (recommended)
npm run dev

# Or run separately:
npm run dev:server  # Express on port 3000
npm run dev:ui      # Vite on port 5173

# Type checking
npm run typecheck

# Build for production
npm run build

# Start production server
npm start
```

## Project Status

**✅ Completed** (Phases 1-2):
- Package setup and configuration
- Express server with WebSocket
- React UI with Vite
- WebSocket client with ping/pong testing

**⏳ In Progress** (Phase 3):
- Terminal control (tmux integration)

**📋 Planned** (Phases 4-9):
- LLM integration (OpenAI GPT-4)
- Agent orchestrator
- Speech-to-Text (Deepgram)
- Text-to-Speech (OpenAI)
- Audio streaming
- UI polish

See [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) for complete details.

## Environment Variables

```bash
OPENAI_API_KEY=sk-...      # GPT-4 and TTS
DEEPGRAM_API_KEY=...       # Streaming STT
STT_MODEL=whisper-1        # Optional: override to gpt-4o-transcribe, etc.
STT_CONFIDENCE_THRESHOLD=-3.0  # Optional: reject low-confidence clips
STT_DEBUG_AUDIO_DIR=.stt-debug # Optional: persist raw dictation audio for debugging
PASEO_HOME=~/.paseo        # Runtime state directory (agents/, etc.)
PASEO_PORT=6767            # Voice server + MCP port (falls back to 6767)
PORT=3000                  # Server port
NODE_ENV=development       # Environment
```

`PASEO_HOME` defaults to `~/.paseo` and isolates runtime artifacts like `agents/`. `PASEO_PORT` takes precedence over `PORT` and controls both the HTTP server and MCP endpoint. For blue/green testing you can run a parallel server without touching production state:

```bash
PASEO_HOME=~/.paseo-blue PASEO_PORT=7777 npm run dev
```

## Tech Stack

- **Server**: Express, TypeScript, ws (WebSocket)
- **Client**: React 18, Vite, TypeScript
- **Terminal**: tmux (via child_process)
- **AI**: OpenAI (LLM + TTS), Deepgram (STT)

## Testing

Currently manual testing via:
1. Start servers: `npm run dev`
2. Open http://localhost:5173
3. Test WebSocket connection (green status indicator)
4. Click "Send Ping" button to test communication

More testing guidance as features are implemented.

## License

MIT
