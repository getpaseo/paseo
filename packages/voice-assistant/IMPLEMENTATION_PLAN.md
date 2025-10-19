# Voice Assistant - Implementation Plan

## Project Overview

**Goal**: Build a voice-controlled terminal assistant that runs locally as a single Express service.

**Architecture**:
- Single Express process serving everything
- Vite React UI bundled and served from Express
- WebSocket for control messages (activity log, status updates)
- Agent logic (STT/TTS/LLM pipeline using APIs)
- Daemon logic (terminal control using tmux) - same process, direct function calls
- Audio streaming solution (Phase 8)

## Technology Stack

### Server
- **Runtime**: Node.js with TypeScript
- **Framework**: Express
- **WebSocket**: ws library
- **Terminal Control**: tmux (via child_process)
- **APIs**:
  - OpenAI (GPT-4 Turbo for LLM, TTS)
  - Deepgram (Streaming STT)

### Client
- **Framework**: React 18
- **Build Tool**: Vite
- **Styling**: CSS (custom)
- **WebSocket**: Native WebSocket API

## Package Structure

```
packages/voice-assistant/
├── package.json
├── tsconfig.json              # UI TypeScript config
├── tsconfig.server.json       # Server TypeScript config
├── tsconfig.node.json         # Vite config TypeScript
├── vite.config.ts             # Vite bundler config
├── .env.example
├── .gitignore
├── IMPLEMENTATION_PLAN.md     # This file
│
├── src/
│   ├── server/
│   │   ├── index.ts                    # ✅ Express + HTTP server entry point
│   │   ├── types.ts                    # ✅ Shared server types
│   │   ├── websocket-server.ts         # ✅ WebSocket server
│   │   │
│   │   ├── agent/
│   │   │   ├── orchestrator.ts         # Agent pipeline coordinator
│   │   │   ├── stt-deepgram.ts         # Deepgram streaming STT
│   │   │   ├── llm-openai.ts           # OpenAI GPT-4 with tools
│   │   │   ├── tts-openai.ts           # OpenAI TTS (stream)
│   │   │   └── system-prompt.ts        # Load from agent-prompt.md
│   │   │
│   │   └── daemon/
│   │       ├── terminal-manager.ts     # Terminal control API
│   │       ├── tmux.ts                 # tmux primitives (from mcp-server)
│   │       └── tool-definitions.ts     # LLM tool schemas
│   │
│   └── ui/
│       ├── index.html                  # ✅ HTML entry point
│       ├── main.tsx                    # ✅ React root
│       ├── App.tsx                     # ✅ Main app component
│       ├── App.css                     # ✅ App styles
│       ├── index.css                   # ✅ Global styles
│       │
│       ├── components/
│       │   ├── VoiceInterface.tsx      # Main voice UI
│       │   ├── ActivityLog.tsx         # Conversation log
│       │   ├── ConnectionIndicator.tsx # Connection status
│       │   └── AudioVisualizer.tsx     # Audio waveform
│       │
│       ├── hooks/
│       │   ├── useWebSocket.ts         # ✅ WebSocket client
│       │   └── useWebRTC.ts            # WebRTC client (Phase 8)
│       │
│       └── lib/
│           └── audio-utils.ts          # Audio processing utilities
│
└── dist/
    ├── server/    # Compiled TypeScript
    └── ui/        # Built Vite app
```

---

## Implementation Phases

### ✅ Phase 1: Foundation (COMPLETED)

**Tasks**:
1. ✅ Create package structure and configuration files
2. ✅ Set up package.json with dependencies and scripts
3. ✅ Create TypeScript configurations (tsconfig.json, tsconfig.server.json)
4. ✅ Create Vite configuration (vite.config.ts)
5. ✅ Create basic Express server (src/server/index.ts)
6. ✅ Create basic Vite React app (src/ui/)
7. ✅ Install dependencies and test dev servers

**Key Files Created**:
- `src/server/index.ts` - Express server with production static file serving
- `src/server/types.ts` - Shared TypeScript types
- `src/ui/App.tsx` - Main React component
- `src/ui/index.html` - HTML entry point
- `vite.config.ts` - Vite build configuration

**Development Workflow**:
```bash
npm run dev        # Runs both servers (concurrently)
npm run dev:server # Express on port 3000
npm run dev:ui     # Vite on port 5173
```

**Production Build**:
```bash
npm run build      # Builds UI + server
npm start          # Serves from dist/
```

---

### ✅ Phase 2: WebSocket Communication (COMPLETED)

**Tasks**:
1. ✅ Add WebSocket server (websocket-server.ts)
2. ✅ Add WebSocket client hook (useWebSocket.ts)
3. ✅ Test WebSocket ping/pong communication

**Key Features**:
- WebSocket server on `/ws` path
- Client-side `useWebSocket` hook with auto-reconnect
- Message handler registration system
- Ping/pong messaging for connection testing
- Activity log UI component
- Real-time connection status indicator

**Key Files Created**:
- `src/server/websocket-server.ts` - VoiceAssistantWebSocketServer class
- `src/ui/hooks/useWebSocket.ts` - Client WebSocket hook
- Updated `src/ui/App.tsx` - WebSocket integration & activity log

**WebSocket Message Types**:
```typescript
interface WebSocketMessage {
  type: 'activity_log' | 'status' | 'webrtc_signal' | 'ping' | 'pong';
  payload: unknown;
}
```

**Testing**:
1. Start both servers: `npm run dev`
2. Open http://localhost:5173
3. Click "Send Ping" button
4. See "Received pong from server" in activity log

---

### ⏳ Phase 3: Terminal Control (Daemon)

**Tasks**:
1. ⏳ Copy tmux.ts from mcp-server package
2. ⏳ Create terminal-manager.ts with tool functions
3. ⏳ Create tool-definitions.ts for LLM schemas
4. ⏳ Test terminal operations (list, create, capture)

**Objectives**:
- Reuse existing tmux primitives from mcp-server
- Create high-level terminal management API
- Define LLM tool schemas for terminal operations
- Test terminal creation, command execution, output capture

**Terminal Tools** (7 core operations):
```typescript
// Tool functions to implement in terminal-manager.ts
1. listTerminals() → TerminalInfo[]
2. createTerminal(name, workingDirectory, initialCommand?)
3. captureTerminal(terminalId, lines?, wait?)
4. sendText(terminalId, text, pressEnter?, return_output?)
5. sendKeys(terminalId, keys, repeat?, return_output?)
6. renameTerminal(terminalId, name)
7. killTerminal(terminalId)
```

**Terminal Model**:
- Default tmux session: `voice-dev`
- Terminal = tmux window (single pane)
- Terminal ID = window ID (format: `@123`)
- Working directory set on creation

---

### ⏳ Phase 4: LLM Integration

**Tasks**:
1. ⏳ Copy agent-prompt.md from agent-python
2. ⏳ Create system-prompt.ts to load prompt file
3. ⏳ Create llm-openai.ts (GPT-4 with function calling)
4. ⏳ Test LLM integration with tool calls

**Objectives**:
- Reuse existing system prompt from Python agent
- Implement OpenAI GPT-4 Turbo with function calling
- Define terminal tools as OpenAI functions
- Test: "create a terminal called test" → executes createTerminal()

**LLM Configuration**:
```typescript
{
  model: "gpt-4-turbo",
  tools: terminalToolDefinitions,
  tool_choice: "auto",
  stream: true
}
```

---

### ⏳ Phase 5: Agent Orchestrator

**Tasks**:
1. ⏳ Create agent orchestrator.ts
2. ⏳ Wire text input → LLM → tool execution → response
3. ⏳ Emit activity log events to WebSocket
4. ⏳ Test end-to-end text-based commands

**Objectives**:
- Create main agent loop
- Handle: user input → LLM → tool calls → terminal → response
- Broadcast activity to WebSocket clients
- Test complete text-based interaction flow

**Agent Loop**:
```
1. Receive user input (text/transcript)
2. Add to conversation context
3. Call LLM with tools
4. If tool calls:
   a. Execute each tool via terminal-manager
   b. Add results to context
   c. Call LLM again with results
5. Return final response
6. Broadcast all events to WebSocket
```

---

### ⏳ Phase 6: Speech-to-Text (Deepgram)

**Tasks**:
1. ⏳ Add Deepgram STT integration (stt-deepgram.ts)
2. ⏳ Test STT with audio input

**Objectives**:
- Implement Deepgram streaming STT
- Handle audio chunks from client
- Return transcript fragments in real-time
- Detect end-of-utterance

**Deepgram Configuration**:
```typescript
{
  model: "nova-2",
  language: "en",
  smart_format: true,
  punctuate: true,
  interim_results: true
}
```

---

### ⏳ Phase 7: Text-to-Speech (OpenAI)

**Tasks**:
1. ⏳ Add OpenAI TTS integration (tts-openai.ts)
2. ⏳ Test TTS with text input

**Objectives**:
- Implement OpenAI TTS API
- Convert text responses to audio
- Stream audio chunks to client
- Handle playback in browser

**TTS Configuration**:
```typescript
{
  model: "tts-1",
  voice: "alloy",
  response_format: "pcm"  // or "opus" for streaming
}
```

---

### ⏳ Phase 8: Audio Streaming

**Tasks**:
1. ⏳ Research WebRTC alternatives for audio streaming
2. ⏳ Implement audio streaming solution
3. ⏳ Test end-to-end voice interaction

**Objectives**:
- Implement bidirectional audio streaming
- Browser → Server: Microphone input
- Server → Browser: TTS output
- Consider: WebRTC (browser native) or WebSocket audio

**Note**:
- `wrtc` package removed due to native compilation issues
- Alternative options:
  1. **WebRTC (browser-to-browser via signaling)** - Most robust
  2. **WebSocket audio streaming** - Simpler, less efficient
  3. **simple-peer** - WebRTC wrapper library
  4. **MediaRecorder API** - Send audio chunks via WebSocket

---

### ⏳ Phase 9: UI Polish

**Tasks**:
1. ⏳ Create ActivityLog component (proper component)
2. ⏳ Create ConnectionIndicator component
3. ⏳ Add mute/unmute controls
4. ⏳ Polish UI and test full application

**Objectives**:
- Extract activity log into reusable component
- Add microphone mute/unmute button
- Add visual audio level indicator
- Improve styling and UX
- End-to-end testing

---

## Environment Variables

`.env` file (copy from `.env.example`):
```bash
# OpenAI API Key (for GPT-4 and TTS)
OPENAI_API_KEY=sk-...

# Deepgram API Key (for streaming STT)
DEEPGRAM_API_KEY=...

# Server Configuration
PORT=3000
NODE_ENV=development
```

---

## Development Commands

```bash
# Install dependencies
npm install

# Development (runs both servers)
npm run dev

# Development (individual servers)
npm run dev:server   # Express on port 3000
npm run dev:ui       # Vite on port 5173

# Build
npm run build:ui     # Build Vite UI → dist/ui/
npm run build:server # Compile TS → dist/server/
npm run build        # Build both

# Production
npm start            # Serve from dist/

# Type checking
npm run typecheck    # Check both UI and server types
```

---

## Testing Strategy

### Phase 1-2 (Foundation + WebSocket)
- ✅ Manual: Start servers, check endpoints
- ✅ Manual: Open UI, test ping/pong

### Phase 3 (Terminal Control)
- Manual: Call terminal-manager functions from server
- Manual: Verify tmux windows created/destroyed
- Manual: Check command execution and output capture

### Phase 4 (LLM)
- Manual: Send text prompts, check tool calls
- Manual: Verify tool execution results in context

### Phase 5 (Orchestrator)
- Manual: Send "create a terminal called test"
- Verify: LLM calls createTerminal tool
- Verify: Activity log shows tool call and result

### Phase 6-7 (STT/TTS)
- Manual: Record audio, check transcript
- Manual: Send text, check audio playback

### Phase 8 (Audio Streaming)
- Manual: Speak into microphone
- Verify: Real-time transcription
- Verify: Agent response plays back

### Phase 9 (Full E2E)
- Manual: Complete voice interaction loop
- Test: Various terminal commands via voice
- Test: Error handling and edge cases

---

## Key Decisions & Trade-offs

### 1. **Single Process Architecture**
- **Decision**: Run agent + daemon in same process
- **Why**: Simpler V1, avoid IPC complexity
- **Future**: Can split into microservices later

### 2. **OpenAI All-in-One**
- **Decision**: Use OpenAI for both LLM and TTS, Deepgram for STT
- **Why**: Simpler integration, fewer providers
- **Note**: Deepgram required because OpenAI Whisper doesn't support streaming

### 3. **Removed wrtc Package**
- **Decision**: Defer WebRTC server implementation to Phase 8
- **Why**: `wrtc` has native compilation issues
- **Alternative**: Will use browser-native WebRTC or WebSocket audio

### 4. **Auto-Execute Terminal Commands**
- **Decision**: No permission prompts in V1
- **Why**: Faster development, simpler UX
- **Future**: Add permission system in V2

### 5. **Reuse Existing Code**
- **Decision**: Copy tmux.ts and agent-prompt.md from existing packages
- **Why**: Proven, tested code
- **Benefit**: Consistent terminal model across packages

---

## Current Progress

**✅ Completed**: 10/33 tasks (30%)
- Phase 1: Foundation (7 tasks)
- Phase 2: WebSocket (3 tasks)

**⏳ In Progress**: Phase 3 (Terminal Control)

**📋 Remaining**: 23 tasks
- Phase 3: 4 tasks
- Phase 4: 4 tasks
- Phase 5: 4 tasks
- Phase 6: 2 tasks
- Phase 7: 2 tasks
- Phase 8: 3 tasks
- Phase 9: 4 tasks

---

## Next Steps

1. **Phase 3**: Copy `tmux.ts` from mcp-server
2. **Phase 3**: Create `terminal-manager.ts` with 7 core tools
3. **Phase 3**: Define OpenAI function schemas for tools
4. **Phase 3**: Test terminal operations manually
5. **Phase 4**: Copy `agent-prompt.md` and set up LLM

---

## References

- **Existing Packages**:
  - `packages/mcp-server/src/tmux.ts` - Terminal control primitives
  - `packages/agent-python/agent-prompt.md` - System prompt
  - `packages/web/app/hooks/use-livekit-voice.ts` - LiveKit reference

- **APIs**:
  - [OpenAI API Docs](https://platform.openai.com/docs)
  - [Deepgram API Docs](https://developers.deepgram.com/)
  - [WebRTC API Docs](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API)

---

## Notes

- This is a **V1 implementation** focused on getting a working prototype
- Prioritize simplicity over optimization
- Each phase should be independently testable
- WebSocket infrastructure is ready for real-time updates
- Audio streaming is the most complex remaining piece
