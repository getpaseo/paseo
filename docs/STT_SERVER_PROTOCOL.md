# External STT Server Protocol

This document defines the communication protocol between the Paseo daemon and an external STT (Speech-to-Text) server. The protocol is private to Paseo and designed to be implementable in any language or framework.

## Overview

The Paseo daemon delegates speech recognition to an external STT server over HTTP and WebSocket. The daemon acts as a client; the STT server acts as a service. They communicate over `127.0.0.1` (localhost) by default.

```
App (recording) → WebSocket → Daemon (port 6767) → STT Server (port 10095)
                                                     ├─ HTTP  /transcribe  (batch)
                                                     ├─ WS    /ws/transcribe (streaming)
                                                     └─ HTTP  /health (readiness)
```

## Connection

| Setting | Default | Env var (daemon) | Env var (server) |
|---------|---------|-----------------|-----------------|
| Server URL | `http://127.0.0.1:10095` | `PASEO_FUNASR_URL` | — |
| Server port | `10095` | — | via uvicorn `--port` |
| Connection timeout | 10s (WebSocket), 60s (HTTP) | — | — |

## Endpoints

### 1. Health Check

```
GET /health
```

**Response** (200 OK):
```json
{
  "status": "ok",
  "model_loaded": true
}
```

The daemon does not currently poll this endpoint, but it is useful for manual verification and monitoring.

### 2. Batch Transcription (HTTP)

Used by `STTManager` for non-dictation one-shot transcription (e.g., voice mode).

```
POST /transcribe
Content-Type: multipart/form-data
```

**Request**: Multipart file upload with field name `file`.

| Field | Value |
|-------|-------|
| `file` | Audio file (WAV preferred) |
| Content-Type | `audio/wav` or `audio/pcm` |
| Filename | `audio.wav` or `audio.pcm` |

If Content-Type contains `pcm` or filename ends with `.pcm`, the server wraps the raw bytes in a WAV header (16kHz, mono, 16-bit PCM) before processing.

**Response** (200 OK):
```json
{
  "text": "transcribed text here"
}
```

**Error** (503):
```json
{
  "error": "Models not loaded"
}
```

### 3. Streaming Transcription (WebSocket)

Used by dictation for real-time speech-to-text with partial results.

```
WebSocket /ws/transcribe
```

#### Client → Server Messages

**Audio data** — Binary frames:
- Format: Raw PCM16LE (little-endian signed 16-bit integers)
- Sample rate: 16000 Hz
- Channels: 1 (mono)
- Frame size: Any (typically 3200 bytes = 100ms of audio)
- No WAV header; raw PCM bytes only

**Finish signal** — Text frame:
```json
{
  "type": "finish"
}
```

Sent when the user stops recording. The server should complete any pending transcription and respond with a `final` message.

#### Server → Client Messages

All messages are JSON text frames.

**Partial transcript** — Sent periodically as speech is recognized:
```json
{
  "type": "partial",
  "text": "recognized text so far"
}
```

- The `text` field contains the **cumulative** transcription, not incremental deltas
- Each partial replaces the previous partial entirely
- Sent whenever the recognized text changes
- The daemon emits these as `isFinal: false` transcript events

**Final transcript** — Sent once after the client sends `finish`:
```json
{
  "type": "final",
  "text": "final complete transcription"
}
```

- Contains the definitive transcription of the entire recording
- The daemon emits this as `isFinal: true` transcript event
- The server closes the connection after sending this message

**Error** — Sent on failure:
```json
{
  "type": "error",
  "error": "description of what went wrong"
}
```

#### Session Lifecycle

```
Client                          Server
  |                                |
  |  ---- WebSocket connect ---->  |
  |  <--- connection accepted ---  |
  |                                |
  |  ---- binary (PCM chunk) ---> |  Audio accumulates
  |  ---- binary (PCM chunk) ---> |
  |  ---- binary (PCM chunk) ---> |
  |                                |  Timer fires → ASR on accumulated audio
  |  <--- {"type":"partial"} ----  |  Partial result
  |                                |
  |  ---- binary (PCM chunk) ---> |
  |  ---- binary (PCM chunk) ---> |
  |                                |  Silence detected → ASR on sentence
  |  <--- {"type":"partial"} ----  |  Updated partial (committed sentence)
  |                                |
  |  ---- binary (PCM chunk) ---> |
  |  ---- {"type":"finish"} ----> |  User stops recording
  |                                |  Final pass: transcribe remaining audio
  |  <--- {"type":"final"} -----  |  Definitive result
  |                                |
  |  ---- connection close -----> |
```

## Audio Format

| Property | Value |
|----------|-------|
| Encoding | PCM signed 16-bit little-endian (PCM16LE) |
| Sample rate | 16000 Hz |
| Channels | 1 (mono) |
| Byte order | Little-endian |
| Bytes per sample | 2 |
| Bytes per second | 32000 |

For HTTP batch endpoint: WAV file with the above properties (standard RIFF header).
For WebSocket: Raw PCM bytes without header.

## Server Configuration

The STT server behavior is configurable via environment variables:

| Env var | Default | Description |
|---------|---------|-------------|
| `FUNASR_TIMER_INTERVAL` | `1.5` | Seconds between timer-based ASR during streaming |
| `FUNASR_SILENCE_THRESHOLD` | `500` | Int16 peak amplitude below which audio is considered silent |
| `FUNASR_SILENCE_DURATION_MS` | `600` | Milliseconds of continuous silence to trigger sentence commit |
| `FUNASR_OVERLAP` | `0.5` | Seconds of overlap from previous chunk for context |
| `FUNASR_FINAL_MODE` | `tail` | Final pass strategy: `tail` (only last sentence, ~0.3s) or `full` (VAD re-transcription of all audio) |

## Daemon Configuration

By default, Paseo uses the built-in local STT provider (sherpa-onnx). The external STT server is **opt-in** — you must explicitly enable it.

### Quick Start

1. Start the STT server:
   ```bash
   cd packages/funasr-server
   pip install -r requirements.txt
   python server.py
   ```

2. Configure Paseo to use it (pick one method):

**Method A — Environment variable (per-session):**
```bash
PASEO_DICTATION_STT_PROVIDER=funasr paseo start
```

**Method B — Config file (persistent, recommended):**

Edit `~/.paseo/config.json`:
```json
{
  "features": {
    "dictation": {
      "stt": { "provider": "funasr" }
    }
  }
}
```

Then restart the daemon for changes to take effect.

### Optional: Custom Server URL

If the STT server runs on a non-default address:

**Environment variable:**
```bash
PASEO_FUNASR_URL=http://192.168.1.100:10095
```

**Config file:**
```json
{
  "providers": {
    "funasr": {
      "url": "http://192.168.1.100:10095"
    }
  }
}
```

## Implementing a Custom STT Server

Any server implementing the three endpoints above (health, transcribe, ws/transcribe) can be used as a Paseo STT backend. Requirements:

1. **Health endpoint**: Return `{"status": "ok", "model_loaded": true}` when ready.
2. **HTTP transcribe**: Accept multipart WAV/PCM upload, return `{"text": "..."}`.
3. **WebSocket transcribe**: Accept binary PCM16LE 16kHz mono frames, send JSON `partial`/`final` messages.
4. Listen on `127.0.0.1:10095` (or configure via `PASEO_FUNASR_URL`).

The server is free to use any ASR engine internally (FunASR, Whisper, Vosk, custom model, cloud API, etc.). The protocol is engine-agnostic.
