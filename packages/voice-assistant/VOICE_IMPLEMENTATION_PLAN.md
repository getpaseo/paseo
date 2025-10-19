# Voice Implementation Plan (Phases 6 & 7)

## Research Summary

### OpenAI Whisper API (STT)
**Key Findings:**
- **No Native Streaming Support**: OpenAI Whisper API does NOT support real-time streaming transcription
- **Batch Processing Only**: Must send complete audio files after recording stops
- **Supported Formats**: flac, m4a, mp3, mp4, mpeg, mpga, oga, ogg, wav, webm
- **File Size Limit**: 25 MB maximum
- **API Endpoint**: `/v1/audio/transcriptions`
- **Strategy**: Push-to-talk (click to record, click to stop, then transcribe)

**Alternative Considered:**
- OpenAI Realtime API provides true streaming STT+LLM+TTS in one WebSocket connection
- However, it's a different architecture (conversational AI vs tool-calling assistant)
- For this phase, we'll use Whisper API with push-to-talk model

### OpenAI TTS API
**Key Findings:**
- **Streaming Supported**: Yes, via chunk transfer encoding
- **Supported Formats**: mp3, opus, aac, flac, wav, pcm
- **Available Voices**: alloy, echo, fable, onyx, nova, shimmer
- **Quality Models**:
  - `tts-1`: Faster, lower latency, normal quality
  - `tts-1-hd`: Higher quality, slower
- **API Endpoint**: `/v1/audio/speech`
- **Default Format**: MP3

### Browser Audio APIs
**MediaRecorder API (Audio Capture):**
- **Widely Supported**: Chrome, Firefox, Safari, Edge (since 2021)
- **Format Support Varies**:
  - Chrome/Opera: `audio/webm;codecs=opus`
  - Firefox: `audio/ogg;codecs=opus` (also supports webm since Firefox 63)
  - Need to check `MediaRecorder.isTypeSupported()` at runtime
- **Recommended Approach**: Capture as WebM/Opus, convert if needed
- **Events**: `dataavailable` for chunks, `stop` for complete recording

**Web Audio API (Audio Playback):**
- **Challenge**: `decodeAudioData()` requires complete files, not chunks
- **Solution Options**:
  1. Use `<audio>` element with blob URLs (simpler, works with MP3)
  2. Use MediaSource Extensions for true streaming
  3. Buffer complete audio before playback
- **Recommended**: Option 1 for simplicity - buffer complete TTS response, then play

## Architecture Decisions

### STT Flow (Push-to-Talk Model)
```
User clicks microphone button
  ↓
Browser captures audio via MediaRecorder
  ↓
Audio buffered in browser as WebM/Opus
  ↓
User clicks stop button
  ↓
Complete audio sent to server via WebSocket (base64 encoded)
  ↓
Server saves as temporary file (WebM)
  ↓
Server converts to MP3 if needed (using FFmpeg or accept WebM directly)
  ↓
Server calls OpenAI Whisper API with audio file
  ↓
Transcript returned and fed to orchestrator
  ↓
processUserMessage() handles as normal text input
```

### TTS Flow (Buffer-and-Play Model)
```
Orchestrator generates LLM response (streaming text)
  ↓
Server buffers complete response text
  ↓
Server calls OpenAI TTS API with complete text
  ↓
TTS returns audio (MP3 format, streamed from OpenAI)
  ↓
Server buffers complete audio
  ↓
Server sends complete audio to browser via WebSocket (base64 encoded)
  ↓
Browser creates Blob URL from audio data
  ↓
Browser plays using <audio> element
  ↓
Queue management: only play next when current finishes
```

**Rationale for Buffer-and-Play:**
- Simpler implementation (no streaming audio chunks)
- Avoids "clicks" between chunks
- Works reliably across all browsers
- TTS API is fast enough that latency is acceptable
- Can be upgraded to true streaming later if needed

## Implementation Plan

### Phase 6A: STT Integration

#### 1. Server-side STT Module (`src/server/agent/stt-openai.ts`)
```typescript
export interface STTConfig {
  apiKey: string;
  model?: 'whisper-1';
}

export interface TranscriptionResult {
  text: string;
  language?: string;
  duration?: number;
}

export function initializeSTT(config: STTConfig): void;
export async function transcribeAudio(audioBuffer: Buffer, format: string): Promise<TranscriptionResult>;
```

**Implementation Notes:**
- Use `openai` package (already installed)
- Accept audio buffer and format (webm, mp3, etc.)
- Call `/v1/audio/transcriptions` endpoint
- Return transcript text
- Handle errors gracefully

#### 2. Update WebSocket Message Types (`src/server/types.ts`)
```typescript
export interface WebSocketMessage {
  type: 'activity_log' | 'status' | 'webrtc_signal' | 'ping' | 'pong'
       | 'user_message' | 'assistant_chunk'
       | 'audio_chunk' | 'audio_output' | 'recording_state' | 'transcription_result';
  payload: unknown;
}

export interface AudioChunkPayload {
  audio: string; // base64 encoded audio data
  format: string; // 'webm', 'ogg', etc.
  isLast: boolean; // true when recording stopped
}

export interface RecordingStatePayload {
  isRecording: boolean;
}

export interface TranscriptionResultPayload {
  text: string;
  duration?: number;
}
```

#### 3. Add Audio Handling to WebSocket Server (`src/server/websocket-server.ts`)
- Add handler for `audio_chunk` messages
- Buffer audio chunks until `isLast: true`
- Call STT transcription
- Send `transcription_result` back to client
- Feed transcript to orchestrator

#### 4. Wire STT to Orchestrator (`src/server/agent/orchestrator.ts`)
- Add `processAudioInput()` function that wraps `processUserMessage()`
- Add activity log entries for STT events

### Phase 6B: Browser Audio Capture

#### 1. Audio Capture Utility (`src/ui/lib/audio-capture.ts`)
```typescript
export interface AudioCaptureConfig {
  mimeType?: string;
  audioBitsPerSecond?: number;
}

export interface AudioRecorder {
  start(): Promise<void>;
  stop(): Promise<Blob>;
  isRecording(): boolean;
  getSupportedMimeType(): string | null;
}

export function createAudioRecorder(config?: AudioCaptureConfig): AudioRecorder;
```

**Implementation Notes:**
- Request microphone permission
- Detect supported mime type (prefer webm/opus)
- Use MediaRecorder API
- Buffer chunks in array
- Return complete Blob on stop

#### 2. Voice Controls Component (`src/ui/components/VoiceControls.tsx`)
```typescript
interface VoiceControlsProps {
  onAudioRecorded: (audio: Blob, format: string) => void;
  isProcessing: boolean;
}
```

**UI Elements:**
- Microphone button (toggle recording)
- Recording indicator (red dot animation)
- Processing state (spinning loader)
- Visual feedback (waveform or simple animation)

#### 3. Update Main App (`src/ui/App.tsx`)
- Add voice controls section
- Handle `audio_chunk` sending
- Display transcription results
- Show recording/processing states

### Phase 7A: TTS Integration

#### 1. Server-side TTS Module (`src/server/agent/tts-openai.ts`)
```typescript
export interface TTSConfig {
  apiKey: string;
  model?: 'tts-1' | 'tts-1-hd';
  voice?: 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';
  responseFormat?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
}

export interface SpeechResult {
  audio: Buffer;
  format: string;
}

export function initializeTTS(config: TTSConfig): void;
export async function synthesizeSpeech(text: string): Promise<SpeechResult>;
```

**Implementation Notes:**
- Use `openai` package streaming support
- Default to `tts-1` model with `alloy` voice
- Stream from OpenAI and buffer complete audio
- Return as Buffer with format info

#### 2. Update WebSocket Message Types
```typescript
export interface AudioOutputPayload {
  audio: string; // base64 encoded audio data (complete)
  format: string; // 'mp3'
  id: string; // unique ID for queue management
}
```

#### 3. Wire TTS to Orchestrator (`src/server/agent/orchestrator.ts`)
- Modify `processUserMessage()` to optionally synthesize response
- Add `enableTTS: boolean` parameter
- After complete assistant response, call TTS
- Send `audio_output` message to WebSocket clients
- Keep text display alongside audio

### Phase 7B: Browser Audio Playback

#### 1. Audio Playback Utility (`src/ui/lib/audio-playback.ts`)
```typescript
export interface AudioPlayer {
  play(audioData: Blob): Promise<void>;
  stop(): void;
  isPlaying(): boolean;
}

export function createAudioPlayer(): AudioPlayer;
```

**Implementation Notes:**
- Create blob URLs from audio data
- Use `<audio>` element for playback
- Clean up blob URLs after playback
- Simple queue: play next when current finishes

#### 2. Update Voice Controls
- Add speaker indicator (playing state)
- Add stop playback button
- Visual feedback (audio wave or icon animation)

#### 3. Update Main App
- Handle `audio_output` messages
- Queue audio playback
- Show playing state in UI

## Testing Strategy

### Unit Tests (Optional for now)
- Test audio format detection
- Test buffer encoding/decoding
- Test queue management

### Manual Integration Tests

**Test 1: Basic STT**
1. Open UI, ensure WebSocket connected
2. Click microphone button
3. Speak: "list terminals"
4. Click stop recording
5. Verify: Transcription appears in activity log
6. Verify: Tool execution happens
7. Verify: Response displayed

**Test 2: Basic TTS**
1. Send text message: "what terminals are available?"
2. Verify: Text response streams as normal
3. Verify: Audio playback starts automatically
4. Verify: Audio matches text response
5. Verify: Text remains visible during playback

**Test 3: Full Voice Conversation**
1. Record: "create a terminal called voice-test in /tmp"
2. Verify: Transcription → tool call → response → TTS playback
3. Record: "list all terminals"
4. Verify: Second interaction works correctly
5. Verify: Terminal was actually created in tmux

**Test 4: Error Handling**
1. Try recording without microphone permission
2. Try sending empty audio
3. Try sending very long audio (>1 minute)
4. Verify: Graceful error messages

**Test 5: Audio Format Compatibility**
1. Test in Chrome (webm/opus)
2. Test in Firefox (ogg/opus)
3. Test in Safari (if possible)
4. Verify: Format detection works correctly

## Environment Configuration

Add to `.env` (or `.env.example`):
```bash
# OpenAI API Configuration
OPENAI_API_KEY=sk-...

# STT Configuration (optional overrides)
WHISPER_MODEL=whisper-1

# TTS Configuration (optional overrides)
TTS_MODEL=tts-1
TTS_VOICE=alloy
TTS_FORMAT=mp3
```

## Dependencies (Already Installed)
- `openai`: ^4.20.0 ✓
- `ws`: ^8.14.2 ✓
- `uuid`: ^9.0.1 ✓

**No additional dependencies needed!**

## Implementation Order

1. **STT Server Module** - Core transcription logic
2. **Browser Audio Capture** - Get microphone working
3. **WebSocket Audio Messages** - Wire STT to UI
4. **STT Integration Test** - Verify speech-to-text works end-to-end
5. **TTS Server Module** - Core synthesis logic
6. **Browser Audio Playback** - Get speaker working
7. **TTS Integration Test** - Verify text-to-speech works end-to-end
8. **Polish & Error Handling** - Edge cases, loading states, errors
9. **End-to-End Voice Test** - Full conversation flow

## Future Enhancements (Out of Scope)

- Real-time streaming STT (requires different API or third-party service)
- Voice Activity Detection (VAD) for automatic recording stop
- Speaker diarization (multiple speakers)
- Custom wake words
- Interrupt playback to speak
- Noise cancellation
- Audio visualization (waveforms)
- OpenAI Realtime API migration (full duplex voice)

## Success Criteria

✅ User can record voice and get accurate transcription
✅ Transcription feeds into existing text chat flow
✅ Assistant responses are spoken via TTS
✅ Audio quality is acceptable (clear, natural)
✅ Latency is acceptable (< 3 seconds for STT, < 2 seconds for TTS)
✅ Error handling is graceful
✅ Works in Chrome and Firefox
✅ No new dependencies required
✅ Code is maintainable and well-structured
