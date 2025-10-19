# WebRTC Audio Streaming Implementation Plan

**Date:** 2025-10-19
**Phase:** 8 - WebRTC Migration
**Status:** ~~Planning Complete~~ **SUPERSEDED - See Note Below**

---

## ⚠️ ARCHITECTURAL PIVOT - OCTOBER 2025

**This implementation plan has been superseded by a simpler architecture.**

We initially planned to use server-side WebRTC (via werift) to handle bidirectional audio streaming. However, we realized that **server-side WebRTC is not necessary** for our use case.

### What We Actually Need

1. **Browser-side WebRTC audio processing** - Echo cancellation, noise suppression, auto gain control
2. **Simple WebSocket transport** - Send/receive audio between browser and server

### Why Server-Side WebRTC is Unnecessary

- The server doesn't need to be a WebRTC peer
- We only need the browser's audio processing features (available via `getUserMedia()`)
- WebSocket provides simple, reliable transport for audio data
- No need for complex signaling, ICE, STUN, or TURN servers

### Current Architecture (Implemented)

```
Browser                           Server
  ↓                                 ↓
[getUserMedia] → WebRTC Audio Processing → [MediaRecorder]
  ↓                                           ↓
[Base64 Encode] → WebSocket → [Decode] → STT → LLM → TTS
                                                ↓
[Audio Element] ← WebSocket ← [Base64 Encode] ← [MP3]
```

**Key Benefits:**
- Simple architecture (no server-side WebRTC complexity)
- Browser handles all audio processing (echo cancel, noise suppress, AGC)
- WebSocket transport is reliable and easy to debug
- No NAT traversal issues
- Works perfectly for our use case

### See Updated Documentation

For current audio processing architecture, see:
- `/Users/moboudra/dev/voice-dev/packages/voice-assistant/AUDIO_PROCESSING.md`

---

## Original Plan (For Historical Reference)

## Executive Summary

This document outlines the plan to migrate from WebSocket-based audio transport to WebRTC for real-time bidirectional audio streaming. The implementation uses a **dual-connection architecture**:

1. **WebSocket** - Control channel for signaling, text messages, tool notifications, and status updates
2. **WebRTC** - Media channel for low-latency bidirectional audio streaming

---

## Research Findings

### Node.js WebRTC Library Evaluation

After extensive research (avoiding `wrtc` due to native compilation issues), here are the viable options:

#### Option 1: **werift-webrtc** (RECOMMENDED)
- **Repository**: https://github.com/shinyoshiaki/werift-webrtc
- **Status**: Actively maintained (latest: 0.22.2, 3 months ago)
- **Type**: Pure TypeScript/JavaScript implementation
- **Pros**:
  - No native dependencies (no compilation issues)
  - Full TypeScript support
  - Includes ICE/DTLS/SCTP/RTP/SRTP
  - Works in Node.js
  - Active development
- **Cons**:
  - Still maturing (some features incomplete)
  - ICE restart not yet available
  - TURN ICE TLS/TCP not supported
  - No simulcast (send) support yet
- **Verdict**: Best choice for our use case (simple peer-to-peer audio)

#### Option 2: **simple-peer**
- **Repository**: https://github.com/feross/simple-peer
- **Status**: Popular but unmaintained (last update 2021)
- **Type**: Browser + Node.js wrapper around WebRTC
- **Pros**:
  - Simple API
  - Well-documented
  - 312 projects using it
- **Cons**:
  - Requires `wrtc` for Node.js (which we're avoiding)
  - Not updated in 4 years
  - Would need `@roamhq/wrtc` fork
- **Verdict**: Not suitable (requires wrtc)

#### Option 3: **Alternative Approach - Signaling Only**
- **Concept**: Browser handles both WebRTC peers
- **Architecture**: Server acts as signaling relay only
- **Pros**:
  - No Node.js WebRTC library needed
  - Server complexity stays low
  - Browser WebRTC is mature and reliable
- **Cons**:
  - Cannot process audio server-side (defeats our purpose)
  - Cannot wire to STT/TTS on server
- **Verdict**: Not applicable to our use case

### Recommended Approach: **werift-webrtc**

We will use `werift-webrtc` for server-side WebRTC peer connection management. This gives us:

1. Pure JavaScript implementation (no native compilation)
2. Full control over audio streams on the server
3. Ability to wire WebRTC audio tracks to STT/TTS pipelines
4. TypeScript support for better development experience

---

## Architecture Design

### Current Architecture (WebSocket Audio)

```
Browser                           Server
  ↓                                 ↓
[MediaRecorder] → WebSocket → [Buffer] → STT → LLM → TTS → [Buffer] → WebSocket → [Audio Element]
  ↑                                                                                      ↓
[Microphone]                                                                        [Speakers]
```

**Issues:**
- High latency (base64 encoding/decoding)
- Buffering required (push-to-talk)
- Not real-time
- Inefficient for audio transport

### New Architecture (WebRTC + WebSocket)

```
Browser                                Server
  ↓                                      ↓
[RTCPeerConnection] ←─────────────→ [werift.RTCPeerConnection]
  ↑                   WebRTC Audio        ↓
  ↑                                       ↓
[Microphone]                         [Audio Track] → STT Stream → LLM
                                          ↑
                                     [Audio Track] ← TTS Stream
  ↓                                       ↓
[Speakers]          ←─────────────────────┘

WebSocket (signaling only)
  ↓                                      ↓
[WebSocket] ←──── SDP/ICE ────→ [WebSocket Server]
            ←─── Messages ────→
            ←── Tool Logs ────→
```

**Benefits:**
- Real-time audio streaming (low latency)
- No base64 encoding overhead
- Native browser media handling
- Continuous streaming (no push-to-talk requirement)
- Efficient bandwidth usage

---

## Implementation Plan

### Phase 1: Backend Setup

#### Task 1.1: Install werift-webrtc

```bash
cd /Users/moboudra/dev/voice-dev/packages/voice-assistant
npm install werift
```

#### Task 1.2: Create WebRTC Server Module

**File**: `src/server/webrtc/peer-connection.ts`

```typescript
import { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } from 'werift';

export interface WebRTCPeerConfig {
  iceServers?: Array<{
    urls: string | string[];
    username?: string;
    credential?: string;
  }>;
}

export interface WebRTCPeer {
  id: string;
  connection: RTCPeerConnection;
  onAudioTrack: (track: MediaStreamTrack) => void;
  addAudioTrack: (track: MediaStreamTrack) => void;
  close: () => void;
}

export function createWebRTCPeer(config?: WebRTCPeerConfig): WebRTCPeer;
```

**Responsibilities:**
- Create RTCPeerConnection with STUN/TURN configuration
- Handle ICE candidate gathering
- Manage audio track addition/reception
- Connection state management
- Clean shutdown

#### Task 1.3: Create WebRTC Manager

**File**: `src/server/webrtc/manager.ts`

```typescript
import type { VoiceAssistantWebSocketServer } from '../websocket-server.js';
import type { WebRTCPeer } from './peer-connection.js';

export interface WebRTCManager {
  createPeerForClient(clientId: string): Promise<WebRTCPeer>;
  handleOffer(clientId: string, offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit>;
  handleAnswer(clientId: string, answer: RTCSessionDescriptionInit): Promise<void>;
  handleIceCandidate(clientId: string, candidate: RTCIceCandidateInit): Promise<void>;
  removePeer(clientId: string): void;
}

export function createWebRTCManager(wsServer: VoiceAssistantWebSocketServer): WebRTCManager;
```

**Responsibilities:**
- Manage multiple peer connections (one per client)
- Coordinate signaling via WebSocket
- Track connection state
- Clean up disconnected peers

#### Task 1.4: Integrate Signaling with WebSocket

**File**: `src/server/websocket-server.ts` (modifications)

Add handlers for:
- `webrtc_offer` - Client sends SDP offer
- `webrtc_answer` - Client sends SDP answer
- `webrtc_ice_candidate` - Client sends ICE candidate

Add methods:
- `sendWebRTCSignal(clientId, signal)` - Send signaling to specific client

#### Task 1.5: Wire Audio Input to STT

**File**: `src/server/audio/stream-processor.ts` (new)

```typescript
export interface AudioStreamProcessor {
  processInputStream(track: MediaStreamTrack, onTranscript: (text: string) => void): void;
  stop(): void;
}

export function createAudioStreamProcessor(): AudioStreamProcessor;
```

**Responsibilities:**
- Receive WebRTC audio track
- Convert to format suitable for streaming STT
- Buffer audio chunks
- Feed to STT API (may need streaming STT service)
- Emit transcripts as they arrive

**Challenge**: OpenAI Whisper doesn't support streaming. Options:
1. **Option A**: Buffer audio chunks (e.g., 3-second segments) and transcribe incrementally
2. **Option B**: Use streaming STT service (Deepgram, AssemblyAI, Google Speech-to-Text)
3. **Option C**: Keep hybrid model: WebRTC for TTS output, WebSocket for STT input

**Recommendation**: Start with **Option A** (buffered chunks), evaluate **Option B** if latency is too high.

#### Task 1.6: Wire TTS Output to WebRTC

**File**: `src/server/audio/tts-stream.ts` (new)

```typescript
export interface TTSAudioStream {
  sendToTrack(audioBuffer: Buffer, track: MediaStreamTrack): Promise<void>;
  close(): void;
}

export function createTTSAudioStream(): TTSAudioStream;
```

**Responsibilities:**
- Receive TTS audio buffer from OpenAI
- Convert to WebRTC audio frames (RTP packets)
- Send via WebRTC audio track to client
- Handle backpressure and buffering

---

### Phase 2: Frontend Setup

#### Task 2.1: Create WebRTC Client Module

**File**: `src/ui/lib/webrtc-client.ts`

```typescript
export interface WebRTCClient {
  initialize(): Promise<void>;
  createOffer(): Promise<RTCSessionDescriptionInit>;
  handleAnswer(answer: RTCSessionDescriptionInit): Promise<void>;
  handleIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
  addLocalAudioTrack(stream: MediaStream): void;
  onRemoteTrack(callback: (track: MediaStreamTrack) => void): void;
  close(): void;
}

export function createWebRTCClient(
  onIceCandidate: (candidate: RTCIceCandidate) => void,
  onConnectionStateChange: (state: RTCPeerConnectionState) => void
): WebRTCClient;
```

**Responsibilities:**
- Create browser RTCPeerConnection
- Manage local media stream (microphone)
- Handle remote audio track (TTS output)
- Emit ICE candidates for signaling
- Track connection state

#### Task 2.2: Integrate Signaling with WebSocket Hook

**File**: `src/ui/hooks/useWebSocket.ts` (modifications)

Add message handlers:
- `webrtc_offer` - Server sends offer (if server initiates)
- `webrtc_answer` - Server sends answer
- `webrtc_ice_candidate` - Server sends ICE candidate

Add methods:
- `sendWebRTCSignal(type, data)` - Send signaling to server

#### Task 2.3: Create WebRTC Connection Hook

**File**: `src/ui/hooks/useWebRTC.ts` (new)

```typescript
export interface UseWebRTCResult {
  connectionState: RTCPeerConnectionState;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  startConnection: () => Promise<void>;
  stopConnection: () => void;
  error: string | null;
}

export function useWebRTC(wsClient: WebSocketClient): UseWebRTCResult;
```

**Responsibilities:**
- Manage WebRTC client lifecycle
- Coordinate with WebSocket for signaling
- Provide connection state to UI
- Handle errors and reconnection

#### Task 2.4: Update VoiceControls Component

**File**: `src/ui/components/VoiceControls.tsx` (modifications)

Changes:
- Remove `createAudioRecorder()` usage
- Remove push-to-talk button logic
- Add connection toggle: "Connect Voice" / "Disconnect Voice"
- Display connection state
- Use WebRTC local/remote streams instead of MediaRecorder

New UI states:
- Disconnected
- Connecting
- Connected (streaming)
- Error

#### Task 2.5: Handle Remote Audio Playback

**File**: `src/ui/lib/webrtc-playback.ts` (new)

```typescript
export function playRemoteAudioTrack(track: MediaStreamTrack): HTMLAudioElement;
```

**Responsibilities:**
- Create Audio element for remote track
- Attach MediaStream to Audio element
- Auto-play TTS audio as it arrives
- Clean up on disconnect

---

### Phase 3: Integration and Testing

#### Task 3.1: Connection Flow Testing

**Test Case 1: Establish WebRTC Connection**
1. Open browser UI
2. Click "Connect Voice"
3. Grant microphone permission
4. Verify: WebSocket signaling messages exchanged
5. Verify: ICE candidates gathered and exchanged
6. Verify: WebRTC connection state = "connected"
7. Verify: No errors in console

**Expected Latency**: < 2 seconds to establish connection

#### Task 3.2: Audio Input Testing

**Test Case 2: Microphone to Server**
1. Establish WebRTC connection
2. Speak into microphone: "list terminals"
3. Verify: Audio track received on server
4. Verify: Audio data flowing (check logs)
5. Verify: STT processing triggered
6. Verify: Transcript appears in activity log
7. Verify: LLM response generated

**Expected Latency**: < 1 second for STT (with buffered chunks)

#### Task 3.3: Audio Output Testing

**Test Case 3: TTS to Browser**
1. Establish WebRTC connection
2. Speak: "what terminals are available?"
3. Verify: LLM response generated
4. Verify: TTS audio synthesized
5. Verify: Audio sent via WebRTC track
6. Verify: Audio plays in browser automatically
7. Verify: Clear, natural speech quality

**Expected Latency**: < 1 second for TTS

#### Task 3.4: Full Conversation Testing

**Test Case 4: Continuous Voice Conversation**
1. Establish connection
2. Speak: "create a terminal called test in /tmp"
3. Wait for response (spoken)
4. Speak: "list all terminals"
5. Verify: Both interactions work smoothly
6. Verify: No audio cutoff or overlap
7. Verify: Terminal actually created in tmux

**Expected Total Round-Trip**: < 3 seconds

#### Task 3.5: Error Handling Testing

**Test Case 5: Connection Failures**
1. Deny microphone permission → graceful error
2. Kill WebSocket connection → WebRTC reconnect attempt
3. ICE gathering fails → show connection error
4. Send invalid SDP → handle error gracefully

**Test Case 6: Audio Processing Failures**
1. STT API error → show error, allow retry
2. TTS API error → text-only fallback
3. Audio codec mismatch → log warning, attempt recovery

---

## WebRTC Message Types

### Updated `src/server/types.ts`

```typescript
export interface WebSocketMessage {
  type: 'activity_log' | 'status' | 'ping' | 'pong' | 'user_message' | 'assistant_chunk'
       | 'audio_chunk' | 'audio_output' | 'recording_state' | 'transcription_result'
       // New WebRTC signaling types:
       | 'webrtc_offer' | 'webrtc_answer' | 'webrtc_ice_candidate';
  payload: unknown;
}

export interface WebRTCOfferPayload {
  sdp: string;
  type: 'offer';
}

export interface WebRTCAnswerPayload {
  sdp: string;
  type: 'answer';
}

export interface WebRTCIceCandidatePayload {
  candidate: string;
  sdpMLineIndex: number | null;
  sdpMid: string | null;
}
```

---

## Signaling Flow Diagram

```
Browser                                    Server
  |                                          |
  |--- Connect to WebSocket --------------->|
  |<-- WebSocket connected -----------------|
  |                                          |
  |--- Click "Connect Voice" --------------->|
  |                                          |
  |--- getUserMedia (microphone) ---------->|
  |<-- MediaStream acquired -----------------|
  |                                          |
  |--- Create RTCPeerConnection ------------>|
  |--- Add audio track --------------------->|
  |--- createOffer() ----------------------->|
  |                                          |
  |--- WS: webrtc_offer -------------------->|
  |                   SDP offer              |
  |                                          |--- Create RTCPeerConnection
  |                                          |--- setRemoteDescription(offer)
  |                                          |--- createAnswer()
  |                                          |
  |<-- WS: webrtc_answer --------------------|
  |          SDP answer                      |
  |                                          |
  |--- setRemoteDescription(answer) -------->|
  |                                          |
  |<-- WS: webrtc_ice_candidate -------------|
  |--- WS: webrtc_ice_candidate ------------>|
  |<-- WS: webrtc_ice_candidate -------------|
  |--- WS: webrtc_ice_candidate ------------>|
  |          (multiple ICE exchanges)        |
  |                                          |
  |========= WebRTC Connection Established ==|
  |                                          |
  |--- Audio streaming ---------------------->|--- Audio track received
  |                                          |--- STT processing
  |                                          |--- LLM response
  |                                          |--- TTS synthesis
  |<-- Audio streaming ----------------------|--- Send via audio track
  |                                          |
```

---

## Configuration

### Environment Variables

```bash
# Existing
OPENAI_API_KEY=sk-...
TTS_VOICE=alloy
TTS_MODEL=tts-1

# New (optional)
WEBRTC_STUN_SERVER=stun:stun.l.google.com:19302
WEBRTC_TURN_SERVER=             # Optional TURN server
WEBRTC_TURN_USERNAME=           # Optional
WEBRTC_TURN_CREDENTIAL=         # Optional
```

### Default STUN/TURN Configuration

```typescript
const defaultIceServers = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];
```

For most peer-to-peer scenarios, STUN is sufficient. TURN is only needed for restrictive NAT/firewall environments.

---

## Migration Strategy

### Hybrid Approach (Recommended)

To minimize risk, implement WebRTC in parallel with existing WebSocket audio:

**Phase 8A: WebRTC for TTS Only**
- Keep WebSocket for STT input (existing push-to-talk)
- Use WebRTC for TTS output (lower latency playback)
- Test and validate

**Phase 8B: WebRTC for STT (Buffered Chunks)**
- Add WebRTC audio input
- Buffer 2-3 second chunks
- Send chunks to Whisper API
- Compare latency with WebSocket approach

**Phase 8C: Full WebRTC (Optional Streaming STT)**
- Evaluate streaming STT services (Deepgram, AssemblyAI)
- If beneficial, replace Whisper with streaming STT
- Remove WebSocket audio code

**Phase 8D: Cleanup**
- Remove old WebSocket audio handlers
- Remove MediaRecorder code
- Remove audio-capture.ts and audio-playback.ts
- Update documentation

---

## STT Streaming Strategy

### Challenge: OpenAI Whisper is Not Streaming

**Current State**: Whisper requires complete audio files.

**Options for WebRTC Audio Input**:

1. **Option A: Buffered Chunks (Simple)**
   - Buffer WebRTC audio track for N seconds (e.g., 3 seconds)
   - Send buffer to Whisper API
   - Repeat for continuous transcription
   - **Pros**: Works with existing Whisper API, simple
   - **Cons**: Still has buffering delay, not true real-time

2. **Option B: Streaming STT Service (Advanced)**
   - Replace Whisper with streaming-capable service:
     - **Deepgram**: WebSocket streaming, excellent accuracy
     - **AssemblyAI**: Universal Streaming model
     - **Google Speech-to-Text**: Streaming recognition
     - **Azure Speech**: Real-time transcription
   - **Pros**: True real-time transcription, lower latency
   - **Cons**: Additional service, potential cost increase

3. **Option C: Hybrid Model (Conservative)**
   - Use WebRTC for TTS output only (low-latency playback)
   - Keep WebSocket for STT input (push-to-talk)
   - **Pros**: Simple migration, reuses existing STT
   - **Cons**: Doesn't achieve full real-time input

**Recommendation**: Start with **Option C** (hybrid), then evaluate **Option A** (buffered chunks). Consider **Option B** (streaming STT) if latency is critical.

### Deepgram Integration (If Pursuing Option B)

```bash
npm install @deepgram/sdk
```

```typescript
import { createClient } from '@deepgram/sdk';

const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

const connection = deepgram.listen.live({
  model: 'nova-2',
  language: 'en-US',
  smart_format: true,
});

connection.on('transcript', (data) => {
  console.log('Transcript:', data.channel.alternatives[0].transcript);
});

// Send audio chunks from WebRTC track
audioTrack.on('data', (chunk) => {
  connection.send(chunk);
});
```

**Note**: The Deepgram SDK is already installed in the project (`@deepgram/sdk: ^3.4.0`).

---

## Dependencies

### New Dependencies

```json
{
  "dependencies": {
    "werift": "^0.22.2"
  }
}
```

### Existing Dependencies (No Changes)

- `openai`: ^4.20.0
- `ws`: ^8.14.2
- `@deepgram/sdk`: ^3.4.0 (already installed, may use for streaming STT)
- `uuid`: ^9.0.1

---

## File Structure

```
src/
├── server/
│   ├── webrtc/
│   │   ├── peer-connection.ts      # NEW: WebRTC peer wrapper
│   │   ├── manager.ts               # NEW: Peer manager
│   │   └── signaling.ts             # NEW: Signaling coordination
│   ├── audio/
│   │   ├── stream-processor.ts      # NEW: Audio input processing
│   │   └── tts-stream.ts            # NEW: TTS to WebRTC track
│   ├── websocket-server.ts          # MODIFIED: Add WebRTC signaling
│   ├── types.ts                     # MODIFIED: Add WebRTC types
│   └── index.ts                     # MODIFIED: Initialize WebRTC
├── ui/
│   ├── lib/
│   │   ├── webrtc-client.ts         # NEW: Browser WebRTC client
│   │   └── webrtc-playback.ts       # NEW: Remote audio playback
│   ├── hooks/
│   │   ├── useWebRTC.ts             # NEW: WebRTC connection hook
│   │   └── useWebSocket.ts          # MODIFIED: Add signaling
│   ├── components/
│   │   └── VoiceControls.tsx        # MODIFIED: WebRTC UI
│   └── App.tsx                      # MODIFIED: Integrate WebRTC
```

---

## Performance Expectations

### Latency Comparison

| Metric                  | WebSocket (Current) | WebRTC (Target) |
|-------------------------|---------------------|-----------------|
| STT Latency             | 1-3 seconds         | 0.5-2 seconds   |
| TTS Latency             | 1-2 seconds         | 0.5-1 second    |
| Total Round-Trip        | 3-5 seconds         | 1-3 seconds     |
| Audio Quality           | Good                | Excellent       |
| Bandwidth Efficiency    | Low (base64)        | High (binary)   |

### Expected Improvements

- **50-60% reduction** in total latency
- **30-40% reduction** in bandwidth usage
- **Improved audio quality** (no encoding overhead)
- **True streaming** capability (with streaming STT)

---

## Known Limitations and Risks

### Technical Risks

1. **werift Maturity**: Library is still maturing
   - Mitigation: Extensive testing, fallback to WebSocket

2. **Browser Compatibility**: WebRTC support varies
   - Mitigation: Feature detection, graceful degradation

3. **NAT/Firewall Issues**: May require TURN server
   - Mitigation: Provide TURN configuration option

4. **STT Streaming**: OpenAI Whisper doesn't stream
   - Mitigation: Hybrid approach or alternative STT service

### Operational Risks

1. **TURN Server Costs**: If needed for production
   - Mitigation: Use free STUN initially, add TURN only if needed

2. **Increased Complexity**: Two connection types to manage
   - Mitigation: Clear separation of concerns, good documentation

3. **Debugging Difficulty**: WebRTC is complex to debug
   - Mitigation: Extensive logging, use `chrome://webrtc-internals/`

---

## Success Criteria

- ✅ WebRTC connection established reliably between browser and server
- ✅ Microphone audio streams to server via WebRTC in real-time
- ✅ TTS audio streams from server to browser via WebRTC in real-time
- ✅ Total latency < 3 seconds for full voice round-trip
- ✅ Audio quality is excellent (no artifacts, clear speech)
- ✅ WebSocket still handles text messages and tool notifications
- ✅ Connection is stable (no disconnects or audio dropouts)
- ✅ Error handling is graceful (reconnection, fallback)
- ✅ Works in Chrome and Firefox
- ✅ No regression in existing text chat functionality
- ✅ Code is maintainable and well-documented

---

## Implementation Timeline

### Conservative Estimate (Phased Approach)

- **Phase 8A** (WebRTC TTS Only): 2-3 days
  - Install werift, setup basic peer connection
  - Implement signaling
  - Wire TTS to WebRTC output
  - Test playback

- **Phase 8B** (WebRTC STT Buffered): 2-3 days
  - Implement audio input capture
  - Buffer and send chunks to Whisper
  - Test transcription accuracy

- **Phase 8C** (Streaming STT - Optional): 1-2 days
  - Integrate Deepgram or similar
  - Wire WebRTC audio to streaming STT
  - Test real-time transcription

- **Phase 8D** (Cleanup): 1 day
  - Remove old WebSocket audio code
  - Update documentation
  - Final testing

**Total**: 6-9 days

### Aggressive Estimate (Full Implementation)

- **All Phases**: 4-5 days
  - Parallel development of client/server
  - Accept some technical debt
  - Minimal testing between phases

---

## Next Steps

1. **Confirm Approach**: Verify architecture decisions
2. **Install Dependencies**: `npm install werift`
3. **Start with Phase 8A**: Implement TTS via WebRTC first
4. **Iterative Testing**: Test each phase before proceeding
5. **Document Learnings**: Update this plan as we learn

---

## References

- **werift-webrtc**: https://github.com/shinyoshiaki/werift-webrtc
- **WebRTC API (MDN)**: https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API
- **Deepgram Streaming**: https://developers.deepgram.com/docs/streaming
- **WebRTC Signaling**: https://blog.logrocket.com/webrtc-signaling-websocket-node-js/

---

**End of Plan**
