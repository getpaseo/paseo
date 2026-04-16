# Session Sharing — Design Doc

## Overview

Session sharing allows organization members to join a running agent session in real-time for pair programming. The owner selects which members can join, chooses the access level (read-only or full-access), and participants can communicate via WebRTC audio while watching or interacting with the agent together.

## Goals

- Owner shares a session with selected org members via a link
- Two access modes: **read-only** (watch the agent) or **full-access** (send messages to the agent via FIFO queue)
- Real-time presence (who's in the session)
- WebRTC audio between participants (voice chat while pair programming)
- Works across desktop, web, and mobile
- **Daemon stays unchanged** — collaboration is a separate service

## Architecture

Colyseus runs as a **standalone microservice** separate from the daemon. The daemon keeps doing what it does (agent runtime), and Colyseus handles only the collaborative layer.

```
┌────────────┐                                              ┌────────────┐
│  Owner App │                                              │ Member App │
│            │                                              │            │
│  WebRTC ◀──┼──────────── P2P audio ──────────────────────┼──▶ WebRTC  │
└──┬───┬─────┘                                              └──┬───┬─────┘
   │   │                                                       │   │
   │   │  WS (colyseus protocol)    WS (colyseus protocol)    │   │
   │   └──────────┐                     ┌──────────────────────┘   │
   │              ▼                     ▼                          │
   │   ┌─────────────────────────────────────────┐                 │
   │   │        Colyseus Server (standalone)      │                 │
   │   │                                         │                 │
   │   │  SharedSessionRoom                      │                 │
   │   │  ├─ participants (presence)             │                 │
   │   │  ├─ accessLevel (read_only|full_access) │                 │
   │   │  ├─ messageQueue (FIFO)                 │                 │
   │   │  ├─ agentStatus                         │                 │
   │   │  └─ WebRTC signaling relay              │                 │
   │   │                                         │                 │
   │   │  REST/WS ──▶ Auth Server (validate)     │                 │
   │   │  REST/WS ──▶ Daemon (forward messages)  │                 │
   │   └─────────────────────────────────────────┘                 │
   │                                                               │
   │  WS (existing hubcode protocol)                               │
   │  Agent stream, terminal, tools                                │
   └───────────────────┐                     ┌─────────────────────┘
                       ▼                     ▼
              ┌──────────────────────────────────────┐
              │           Daemon (unchanged)          │
              │                                      │
              │  Agent runtime, terminal, MCP         │
              │  Existing WebSocket server            │
              │  No changes needed                    │
              └──────────────────────────────────────┘
```

### Why a separate service

| Concern | Embedded in daemon | Separate service |
|---------|-------------------|-----------------|
| Daemon stability | Risk — new code in agent runtime | Zero risk — daemon untouched |
| Scaling | Tied to daemon (one per machine) | Horizontal with Redis presence |
| Deploy | Redeploy daemon = restart all agents | Independent deploy cycle |
| Multi-daemon | Hard — rooms are in-process | One Colyseus coordinates many daemons |
| Complexity | Daemon grows | Clean separation of concerns |

### Service communication

```
App ──WS──▶ Colyseus Server    (Colyseus protocol: rooms, state sync, signaling)
App ──WS──▶ Daemon             (Hubcode protocol: agent stream, terminal, tools)
Colyseus ──REST──▶ Auth Server (validate tokens, check membership)
Colyseus ──WS──▶ Daemon        (forward FIFO messages to agent)
```

The app connects to **two WebSocket servers simultaneously** when in a shared session:
1. **Daemon WS** — receives agent stream events (existing connection, unchanged)
2. **Colyseus WS** — receives presence updates, queue state, WebRTC signals

### Colyseus server setup

The Colyseus server runs as a standalone Node.js process. In production, it can be a Docker container or a separate deployment. In development, it starts alongside the auth-server.

```
packages/colyseus-server/        ← New package
  src/
    index.ts                     ← Server entrypoint
    rooms/
      shared-session-room.ts     ← Room logic
      schema.ts                  ← Colyseus Schema state
    services/
      auth-service.ts            ← Validate tokens via auth-server REST
      daemon-bridge.ts           ← Forward messages to daemon via WS
    config.ts                    ← Env vars, ports
  package.json
  Dockerfile
```

```typescript
// packages/colyseus-server/src/index.ts
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { SharedSessionRoom } from "./rooms/shared-session-room";

const server = new Server({
  transport: new WebSocketTransport({ /* port from config */ }),
});

server.define("shared_session", SharedSessionRoom);
server.listen(6800);
```

Port allocation:
- `6767` — Daemon (existing)
- `3002` — Auth server (existing)
- `6800` — Colyseus server (new)

## Data model

### Auth server — new tables

```sql
CREATE TABLE session_share (
  id                TEXT PRIMARY KEY,
  token             TEXT NOT NULL UNIQUE,
  daemon_session_id TEXT NOT NULL,
  server_id         TEXT NOT NULL,            -- which daemon host
  org_id            TEXT NOT NULL REFERENCES organization(id),
  owner_id          TEXT NOT NULL REFERENCES "user"(id),
  access_level      TEXT NOT NULL DEFAULT 'read_only',
  allowed_user_ids  JSONB NOT NULL DEFAULT '[]',
  max_participants  INTEGER NOT NULL DEFAULT 5,
  expires_at        TIMESTAMP NOT NULL,
  created_at        TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE session_participant (
  id         TEXT PRIMARY KEY,
  share_id   TEXT NOT NULL REFERENCES session_share(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES "user"(id),
  joined_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  left_at    TIMESTAMP
);
```

### Auth server — new API endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/sessions/share` | Create share token (owner) |
| `GET` | `/api/sessions/share/:token` | Validate token + check membership |
| `DELETE` | `/api/sessions/share/:shareId` | Revoke share (kicks participants) |
| `GET` | `/api/sessions/share/:shareId/participants` | List participants |

#### POST /api/sessions/share

```json
// Request
{
  "daemonSessionId": "abc-123",
  "serverId": "server-456",
  "orgId": "org-789",
  "accessLevel": "full_access",
  "allowedUserIds": ["user-1", "user-2"],
  "expiresInMinutes": 480
}

// Response
{
  "shareId": "share-001",
  "token": "Xk9mQ2",
  "shareUrl": "hubcode://join/Xk9mQ2",
  "accessLevel": "full_access",
  "expiresAt": "2026-04-16T06:00:00Z"
}
```

#### GET /api/sessions/share/:token (validation)

Checks: token exists, not expired, requesting user is in `allowedUserIds`, user is org member.

```json
// Response
{
  "shareId": "share-001",
  "daemonSessionId": "abc-123",
  "serverId": "server-456",
  "accessLevel": "full_access",
  "colyseusRoomId": "shared_session_abc123",
  "owner": { "userId": "owner-1", "username": "Gustavo", "avatarUrl": "..." },
  "participants": [
    { "userId": "user-1", "username": "João", "avatarUrl": "...", "joinedAt": "..." }
  ]
}
```

## Colyseus Room — SharedSessionRoom

### State schema

```typescript
import { Schema, type, MapSchema, ArraySchema } from "@colyseus/schema";

class Participant extends Schema {
  @type("string") userId: string;
  @type("string") username: string;
  @type("string") avatarUrl: string;
  @type("string") role: string;         // "owner" | "collaborator" | "viewer"
  @type("boolean") audioEnabled: boolean;
  @type("boolean") isOnline: boolean;
  @type("uint64") joinedAt: number;
}

class QueuedMessage extends Schema {
  @type("string") id: string;
  @type("string") userId: string;
  @type("string") username: string;
  @type("string") content: string;
  @type("uint64") queuedAt: number;
  @type("string") status: string;       // "queued" | "processing" | "sent"
}

class SharedSessionState extends Schema {
  @type("string") shareId: string;
  @type("string") accessLevel: string;  // "read_only" | "full_access"
  @type("string") agentStatus: string;  // "idle" | "running" | "waiting_input"
  @type({ map: Participant }) participants = new MapSchema<Participant>();
  @type([ QueuedMessage ]) messageQueue = new ArraySchema<QueuedMessage>();
}
```

### Room lifecycle

```typescript
class SharedSessionRoom extends Room<SharedSessionState> {

  private daemonBridge: DaemonBridge;
  private authService: AuthService;

  onCreate(options: {
    shareId: string;
    daemonSessionId: string;
    serverId: string;
    accessLevel: string;
    daemonUrl: string;
  }) {
    this.setState(new SharedSessionState());
    this.state.shareId = options.shareId;
    this.state.accessLevel = options.accessLevel;
    this.state.agentStatus = "idle";

    // Connect to daemon to forward messages and listen to agent status
    this.daemonBridge = new DaemonBridge(options.daemonUrl, options.daemonSessionId);
    this.daemonBridge.onAgentStatus((status) => {
      this.state.agentStatus = status;
    });

    this.authService = new AuthService();

    // Register message handlers
    this.onMessage("chat_to_agent", this.handleChatToAgent.bind(this));
    this.onMessage("webrtc_signal", this.handleWebRTCSignal.bind(this));
    this.onMessage("audio_toggle", this.handleAudioToggle.bind(this));
  }

  async onAuth(client, options: { token: string; userId: string }) {
    // Call auth-server to validate share token + user
    const validation = await this.authService.validateShareToken(options.token, options.userId);
    if (!validation.allowed) {
      throw new Error(validation.reason || "Access denied");
    }
    return validation.user; // { userId, username, avatarUrl, isOwner }
  }

  onJoin(client, options, auth) {
    const p = new Participant();
    p.userId = auth.userId;
    p.username = auth.username;
    p.avatarUrl = auth.avatarUrl;
    p.role = auth.isOwner ? "owner"
      : this.state.accessLevel === "full_access" ? "collaborator" : "viewer";
    p.audioEnabled = false;
    p.isOnline = true;
    p.joinedAt = Date.now();
    this.state.participants.set(auth.userId, p);

    // Track in auth-server
    this.authService.recordJoin(this.state.shareId, auth.userId);
  }

  async onLeave(client, consented) {
    const userId = client.auth.userId;
    try {
      // Allow reconnection (wait 30s before removing)
      await this.allowReconnection(client, 30);
      const p = this.state.participants.get(userId);
      if (p) p.isOnline = true;
    } catch {
      // Reconnection timed out — remove participant
      const p = this.state.participants.get(userId);
      if (p) p.isOnline = false;
      this.authService.recordLeave(this.state.shareId, userId);
    }
  }

  onDispose() {
    this.daemonBridge.disconnect();
  }
}
```

### FIFO message queue

When `accessLevel` is `full_access`, any participant can send messages. They enter a FIFO queue:

```
Queue state (synced to all clients via Colyseus):
  1. [João]   "Fix the type error in auth.ts"     → processing ⏳
  2. [Maria]  "Also update the tests"              → queued
  3. [João]   "Add error handling to the endpoint" → queued
```

```typescript
handleChatToAgent(client, message: { content: string }) {
  const userId = client.auth.userId;
  const participant = this.state.participants.get(userId);

  // Permission check
  if (this.state.accessLevel === "read_only" && participant?.role !== "owner") {
    client.send("error", { message: "This session is read-only" });
    return;
  }

  // Add to FIFO queue
  const queued = new QueuedMessage();
  queued.id = nanoid();
  queued.userId = userId;
  queued.username = participant?.username || "Unknown";
  queued.content = message.content;
  queued.queuedAt = Date.now();
  queued.status = "queued";
  this.state.messageQueue.push(queued);

  this.processQueue();
}

private isProcessing = false;

async processQueue() {
  if (this.isProcessing) return;

  const next = this.state.messageQueue.find(m => m.status === "queued");
  if (!next) return;

  this.isProcessing = true;
  next.status = "processing";

  try {
    // Forward to daemon agent via bridge
    await this.daemonBridge.sendMessage(next.content, next.userId);
    next.status = "sent";
  } catch (error) {
    next.status = "queued"; // Retry
  }

  // Remove sent messages
  const sent = this.state.messageQueue.filter(m => m.status === "sent");
  for (const m of sent) {
    const idx = this.state.messageQueue.indexOf(m);
    if (idx >= 0) this.state.messageQueue.splice(idx, 1);
  }

  this.isProcessing = false;
  this.processQueue(); // Process next
}
```

### Daemon bridge

The Colyseus server connects to the daemon's existing WebSocket as a client to forward messages and receive agent status:

```typescript
// packages/colyseus-server/src/services/daemon-bridge.ts
class DaemonBridge {
  private ws: WebSocket;
  private statusCallback: (status: string) => void;

  constructor(daemonUrl: string, sessionId: string) {
    // Connect to daemon WS as a client
    this.ws = new WebSocket(daemonUrl);
    this.ws.onopen = () => {
      // Send hello with clientId = "colyseus-bridge-{sessionId}"
      this.ws.send(JSON.stringify({
        type: "hello",
        clientId: `colyseus-bridge-${sessionId}`,
      }));
    };
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "session") {
        this.handleAgentEvent(msg.message);
      }
    };
  }

  onAgentStatus(callback: (status: string) => void) {
    this.statusCallback = callback;
  }

  private handleAgentEvent(event: any) {
    // Update agent status based on stream events
    switch (event.type) {
      case "agent_thinking":
      case "agent_working":
        this.statusCallback?.("running");
        break;
      case "stream_finished":
        this.statusCallback?.("idle");
        break;
      case "attention_required":
        this.statusCallback?.("waiting_input");
        break;
    }
  }

  async sendMessage(content: string, userId: string) {
    // Forward message to agent via daemon's existing RPC
    this.ws.send(JSON.stringify({
      type: "session",
      message: {
        type: "send_agent_message_request",
        requestId: nanoid(),
        message: content,
        metadata: { sharedBy: userId },
      },
    }));
  }

  disconnect() {
    this.ws.close();
  }
}
```

## WebRTC audio

### Signaling through Colyseus

The Colyseus room acts as the signaling server for WebRTC — no separate signaling service needed.

```typescript
// In SharedSessionRoom
handleWebRTCSignal(client, signal: {
  targetUserId: string;
  kind: "offer" | "answer" | "ice-candidate";
  data: any;
}) {
  const fromUserId = client.auth.userId;

  // Find the target client
  for (const [, c] of this.clients.entries()) {
    if (c.auth.userId === signal.targetUserId) {
      c.send("webrtc_signal", {
        fromUserId,
        kind: signal.kind,
        data: signal.data,
      });
      return;
    }
  }
}

handleAudioToggle(client, { enabled }: { enabled: boolean }) {
  const p = this.state.participants.get(client.auth.userId);
  if (p) p.audioEnabled = enabled;
}
```

### Peer connection flow

```
When participant joins with audio enabled:

1. New peer sends "offer" to each existing peer (via room signaling)
2. Existing peers respond with "answer"
3. ICE candidates exchanged
4. P2P audio streams established

Mesh topology: each peer connects to every other peer.
For 2-3 participants this is fine. For 4+ consider an SFU.
```

### Platform implementation

| Platform | Library | Notes |
|----------|---------|-------|
| Desktop (Electron) | Native `RTCPeerConnection` | Chrome WebRTC built-in |
| Web (browser) | Native `RTCPeerConnection` | Standard Web API |
| Mobile (React Native) | `react-native-webrtc` | New dependency |

### ICE / TURN configuration

```typescript
const iceConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    // TURN for NAT traversal (when P2P fails)
    {
      urls: "turn:turn.hubcode.ai:3478",
      username: "hubcode",
      credential: "<rotated-credential>",
    },
  ],
};
```

Options for TURN:
- **Cloudflare TURN** — free tier with Workers
- **Twilio TURN** — pay-as-you-go
- **Self-hosted coturn** — full control, Docker container

## App-side integration

### Dual connection model

When a user joins a shared session, the app maintains **two simultaneous connections**:

```typescript
// Connection 1: Existing daemon connection (agent stream)
const daemonWs = useHostRuntimeClient(serverId);

// Connection 2: Colyseus room (collaboration)
const room = useSharedSession(shareToken);
```

The agent chat UI merges both sources:
- **Agent output** comes from the daemon WS (existing stream events)
- **Presence, queue, signals** come from the Colyseus room
- **User messages** go through the Colyseus FIFO queue (which forwards to daemon)

### New hooks

```typescript
// Connect to Colyseus room
function useSharedSession(shareToken: string | null) {
  // Returns: { room, state, connected, error }
}

// Participant presence from room state
function useSessionParticipants(room: Room | null) {
  // Returns: { participants, myRole }
}

// FIFO queue state and actions
function useMessageQueue(room: Room | null) {
  // Returns: { queue, sendMessage, isProcessing }
}

// WebRTC audio management
function useWebRTCAudio(room: Room | null) {
  // Returns: { audioEnabled, toggleAudio, peers }
  // Handles: offer/answer/ICE exchange, peer connection lifecycle
}

// Share management (create/revoke)
function useShareSession(sessionId: string) {
  // Returns: { createShare, revokeShare, shareInfo }
}
```

### UI components

| Component | Where | Description |
|-----------|-------|-------------|
| **ShareSessionButton** | Agent panel header | Opens share modal |
| **ShareSessionModal** | Overlay | Member picker, access level, generate link |
| **ParticipantBar** | Below agent chat header | Avatars + audio indicators + count |
| **AudioControls** | In participant bar | Mic mute/unmute toggle |
| **MessageQueueIndicator** | Above chat input | Shows queue count + currently processing |
| **JoinSessionScreen** | `/join/:token` route | Token validation, preview, join button |

### Share modal flow

```
┌──────────────────────────────────────┐
│  Share this session                  │
│                                      │
│  Access level:                       │
│  ┌──────────┐ ┌──────────────┐      │
│  │ Can view │ │ Can interact │       │
│  └──────────┘ └──────────────┘      │
│                                      │
│  Select members:                     │
│  ☑ João Silva         joao@...      │
│  ☑ Maria Santos       maria@...     │
│  ☐ Pedro Costa        pedro@...     │
│                                      │
│  ┌──────────────────────────────┐   │
│  │  Create share link           │   │
│  └──────────────────────────────┘   │
│                                      │
│  🔗 hubcode://join/Xk9mQ2  [Copy]  │
└──────────────────────────────────────┘
```

### Participant bar

```
┌─────────────────────────────────────────────────────┐
│ 👤Gustavo(🎤) 👤João(🔇) 👤Maria(🎤)  │ 3 in session │
└─────────────────────────────────────────────────────┘
```

## Deployment

### Development

```bash
# Terminal 1: Postgres
docker compose up -d postgres

# Terminal 2: Auth server
cd auth-server && npm run dev

# Terminal 3: Colyseus server (new)
cd packages/colyseus-server && npm run dev

# Terminal 4: Daemon + App
npm run dev
```

### Production (Docker)

```yaml
# docker-compose.yml additions
services:
  colyseus:
    build: ./packages/colyseus-server
    ports:
      - "6800:6800"
    environment:
      AUTH_SERVER_URL: https://auth.hubcode.ai
      REDIS_URL: redis://redis:6379       # For distributed presence
    depends_on:
      - postgres
      - redis

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
```

## Implementation plan

### Phase 1 — Colyseus server + Share model

| Step | Package | Description |
|------|---------|-------------|
| 1.1 | `packages/colyseus/` | Build Colyseus packages |
| 1.2 | `packages/colyseus-server/` | New package: server entrypoint, config |
| 1.3 | `packages/colyseus-server/src/rooms/` | SharedSessionRoom + Schema |
| 1.4 | `packages/colyseus-server/src/services/` | AuthService, DaemonBridge |
| 1.5 | `auth-server/src/db/schema.ts` | Add `session_share`, `session_participant` tables |
| 1.6 | `auth-server/src/app/api/sessions/` | Share CRUD endpoints |

### Phase 2 — App integration + Presence

| Step | Package | Description |
|------|---------|-------------|
| 2.1 | `packages/app/` | Install `colyseus.js` client SDK |
| 2.2 | `packages/app/src/hooks/use-shared-session.ts` | Colyseus room connection hook |
| 2.3 | `packages/app/src/hooks/use-session-participants.ts` | Presence hook |
| 2.4 | `packages/app/src/components/share-session-modal.tsx` | Member selection + link gen |
| 2.5 | `packages/app/src/components/participant-bar.tsx` | Avatars + status |
| 2.6 | `packages/app/src/app/join/[token].tsx` | Join session route |

### Phase 3 — FIFO queue + Full access

| Step | Package | Description |
|------|---------|-------------|
| 3.1 | `packages/colyseus-server/src/rooms/` | FIFO queue logic |
| 3.2 | `packages/colyseus-server/src/services/daemon-bridge.ts` | Forward messages to daemon |
| 3.3 | `packages/app/src/hooks/use-message-queue.ts` | Queue hook |
| 3.4 | `packages/app/src/components/message-queue-indicator.tsx` | Queue UI |

### Phase 4 — WebRTC audio

| Step | Package | Description |
|------|---------|-------------|
| 4.1 | `packages/colyseus-server/src/rooms/` | WebRTC signaling in room |
| 4.2 | `packages/app/src/hooks/use-webrtc-audio.ts` | Peer connection management (web) |
| 4.3 | `packages/app/src/hooks/use-webrtc-audio.native.ts` | react-native-webrtc variant |
| 4.4 | `packages/app/src/components/audio-controls.tsx` | Mic toggle UI |
| 4.5 | ICE/TURN config | TURN server setup |

### Phase 5 — Deep links + Polish

| Step | Package | Description |
|------|---------|-------------|
| 5.1 | Desktop deep link handler | `hubcode://join/:token` |
| 5.2 | Mobile deep link handler | Universal links |
| 5.3 | Revoke share (kick participants) | Owner control |
| 5.4 | E2E testing | Multi-client scenarios |

## Security

- Share tokens are short-lived (default 8 hours)
- Tokens validated by auth-server on every join (checks `allowedUserIds` + org membership)
- Owner can revoke at any time (Colyseus room broadcasts disconnect)
- Agent actions are attributed to the user who sent them (`metadata.sharedBy`)
- WebRTC audio is P2P encrypted (DTLS-SRTP, standard)
- Colyseus ↔ Daemon bridge uses internal network only (not exposed externally)

## Open questions

1. **TURN server hosting** — Cloudflare TURN (free) vs Twilio (paid) vs self-hosted coturn?
2. **Max participants per session** — Start with 5? Mesh WebRTC works up to ~4-5 peers.
3. **Screen sharing** — Deferred. WebRTC supports it, but adds UI complexity. Future phase.
4. **Persistent queue** — Should the FIFO queue survive room disposal? For now, in-memory only.
5. **Agent stream relay** — Should Colyseus relay agent stream events, or should joining members connect directly to the daemon? Direct connection is simpler and avoids double-proxying.
