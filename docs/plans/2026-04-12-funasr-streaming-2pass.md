# FunASR Streaming 2-Pass STT Design

**Goal:** Add streaming speech recognition with 2-pass accuracy — real-time partial results during recording, full re-transcription on finish.

**Architecture:** WebSocket connection between Paseo daemon and FunASR Python server. During recording, simple silence detection triggers per-sentence ASR (pass 1, partial results). On recording end, full audio is re-transcribed with VAD model for best accuracy (pass 2, final result).

## Protocol

**WebSocket endpoint:** `ws://127.0.0.1:10095/ws/transcribe`

**Client → Server:**
- Binary frames: PCM16 16kHz mono audio chunks
- Text frame: `{"type": "finish"}` — recording ended

**Server → Client:**
- `{"type": "partial", "text": "..."}` — per-sentence result (pass 1)
- `{"type": "final", "text": "..."}` — full re-transcription (pass 2)

## Server-Side Flow

1. Receive audio chunks → accumulate to full buffer + feed to silence detector
2. Silence detector: peak amplitude < threshold for 500ms → sentence boundary
3. On sentence boundary → extract sentence audio → ASR → send partial
4. On finish → full buffer with VAD model segmentation → ASR per segment → join → send final
5. Close connection

## Paseo Provider Changes

- `FunASRSTT.createSession()` uses WebSocket instead of HTTP
- `appendPcm16()` sends binary frames directly
- `commit()` sends finish, waits for final
- Partial transcripts emitted as `isFinal: false`
- Final transcript emitted as `isFinal: true`
- HTTP `/transcribe` endpoint kept for non-dictation use

## Auto-Commit Skip

DictationStreamManager skips 15s auto-commit when provider is funasr — FunASR's own VAD handles segmentation.
