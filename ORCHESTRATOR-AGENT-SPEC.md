# Voice Dev: Orchestrator + Agent Chat Architecture Spec

## Paradigm

### Two Interaction Models

**1. Orchestrator (Realtime Voice)**
- Top-level conversational agent
- Controls everything: creates agents, checks status, manages projects
- Realtime voice mode with TTS
- App-level session (not project-specific)

**2. Agent Chat (Text + Voice Notes)**
- Direct interaction with individual coding agents
- Text messages + voice notes (transcribed to text)
- No realtime, no TTS
- Per-agent conversation history

### Key Rules

1. **Realtime always routes to orchestrator** - regardless of which view you're in
2. **Non-realtime routes based on view**:
   - Orchestrator view → orchestrator session
   - Agent view → specific agent
3. **Input area is identical everywhere** - same UI, different routing
4. **TTS is implied by message type** - no flags needed

## Message Architecture

### Separation of Concerns

**Realtime Messages (Orchestrator Only)**
- `audio_chunk` (realtime) → triggers TTS response
- Implies: speech-to-speech interaction
- Server handles with full orchestrator Session

**Non-Realtime Messages**
- `user_text` (orchestrator) → text to orchestrator, no TTS
- `user_audio_note` (orchestrator) → transcribe → text to orchestrator, no TTS
- `send_agent_message` (agent) → text to agent via ACP, no TTS
- `send_agent_audio` (agent) → transcribe → text to agent, no TTS

**Outbound (Existing)**
- Orchestrator: `assistant_chunk`, `activity_log`, `audio_output` (TTS)
- Agents: `agent_update` (session notifications from ACP)

## Message Types

### New Inbound Types

```typescript
// To agent (text)
{
  type: "send_agent_message",
  agentId: string,
  text: string
}

// To agent (voice note)
{
  type: "send_agent_audio",
  agentId: string,
  audio: string, // base64
  format: string,
  isLast: boolean
}

// Separate audio_chunk into realtime context
{
  type: "realtime_audio_chunk", // rename from audio_chunk
  audio: string,
  format: string,
  isLast: boolean
}
```

### Existing Types (Clarified)

```typescript
// To orchestrator (text)
{
  type: "user_text",
  text: string
  // NO disableTTS flag - never has TTS in non-realtime context
}
```

## UI Architecture

### Unified Input Area

**Same everywhere, routes differently:**
- Text input
- Voice note button (push-to-talk, sends when released)
- Realtime toggle

**Routing Logic:**
```
if (realtimeMode) {
  → orchestrator (speech-to-speech)
} else if (viewMode === "agent") {
  → agent[activeAgentId] (text only)
} else {
  → orchestrator (text only)
}
```

### Views

**Orchestrator View (index.tsx)**
- Current chat UI (unchanged)
- Conversation with orchestrator
- Realtime UI when enabled

**Agent View (agent-stream-view.tsx)**
- Enhanced to match orchestrator chat quality
- User messages + agent responses (parsed from session updates)
- Tool calls, thoughts, plans (inline activity)
- Same input area (routed to agent)
- Shows realtime UI if enabled (but messages still go to orchestrator)

### Navigation

- Header: connection status, conversation selector, settings, "New Agent" button
- ActiveProcesses: horizontal list of agents (click to open agent view)
- "Back to Chat" button when in agent view

## Implementation Phases

### Phase 1: Message Routing Foundation

**Server**
- Rename `audio_chunk` → `realtime_audio_chunk` for clarity
- Add `send_agent_message` and `send_agent_audio` message types
- Route non-realtime messages to `agentManager.sendPrompt()`
- Handle audio transcription for agent audio notes

**App**
- Add message routing logic based on `viewMode` and `isRealtimeMode`
- Update WebSocket to handle new message types
- Add per-agent message state: `Map<agentId, MessageEntry[]>`

### Phase 2: Agent Chat Interface

**App**
- Parse `agent_update` messages into chat messages
  - Extract text chunks (user_message_chunk, agent_message_chunk)
  - Extract thoughts (agent_thought_chunk)
  - Merge tool calls with updates
- Enhance agent-stream-view to chat quality:
  - Render user messages
  - Render agent responses (streaming)
  - Render activity inline (thoughts, tools, plans)
  - Remove its own input area (uses shared one)

### Phase 3: Agent Creation

**Server**
- Ensure `createAgent` supports mode selection (already exists)

**App**
- Create agent creation modal
  - Directory input/picker
  - Mode selector dropdown
  - Validate directory exists (optional)
- "New Agent" button in header
- Auto-switch to agent view after creation

### Phase 4: Polish

**App**
- Ensure realtime UI shows in both views
- Clear visual indication of routing (subtle badge/label?)
- Smooth transitions between views
- Handle edge cases (agent killed while viewing, etc.)

## Open Questions

1. Should we show a subtle indicator in the input area showing where messages will go?
2. How to handle agent errors during chat (failed, killed)?
3. Should agent creation modal remember last used directory?
