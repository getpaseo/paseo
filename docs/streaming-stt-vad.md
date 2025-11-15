# Streaming STT + Server-Side VAD Investigation

## Current State

- Mobile clients capture audio with `useSpeechmaticsAudio` (`packages/app/src/hooks/use-speechmatics-audio.ts`) which implements on-device VAD by monitoring volume thresholds and buffering PCM chunks before shipping ~1s payloads to the server.
- `RealtimeContext` forwards those chunks to the websocket as `realtime_audio_chunk` messages with `audio/pcm;rate=16000;bits=16` metadata.
- On the backend `Session.handleAudioChunk` (`packages/server/src/server/session.ts`) reassembles PCM frames, converts them to WAV, and invokes `sttManager.transcribe` once `MIN_STREAMING_SEGMENT_BYTES` (~1s) or an `isLast` marker arrives.
- VAD thresholds currently live on-device, so speech detection varies per hardware, and the server transcribes entire buffered segments rather than performing incremental streaming STT.

## Goals & Non-Goals

- **Primary goal:** Replace the client-side Speechmatics dependency with a server-side streaming STT stack (Whisper, Whisper.cpp, faster-whisper, or paid API) that performs both VAD and transcription so latency and accuracy are consistent across devices.
- **Secondary goals:**
  - Emit partial transcripts while a user is still speaking so we can start LLM abort+prompt earlier.
  - Support future desktop/web clients without duplicating native audio/VAD code.
  - Centralize compliance (PII scrubbing, logging) in the backend.
- **Non-goals for this milestone:** Replacing the downstream LLM pipeline or implementing diarization/speaker separation.

## Candidate Approaches

1. **Open-source Whisper (CUDA/ROCm)**
   - Run faster-whisper or whisper.cpp behind a lightweight gRPC/WebSocket service.
   - Pros: no per-minute vendor fee, deterministic behavior, can fine-tune for barge-in.
   - Cons: requires GPUs with enough VRAM (A10/A40 ~40 tokens/s per stream) and custom scaling logic; streaming Whisper requires chunk-wise decoding glue code (Whisper is batch-only by default).
2. **Managed APIs (OpenAI Realtime STT, Deepgram, AssemblyAI, Speechmatics, etc.)**
   - Pros: out-of-box streaming, built-in VAD, metrics; offloads GPU maintenance.
   - Cons: $$, latency tied to vendor regions, harder to self-host for air-gapped installs.
3. **Hybrid:** Keep Speechmatics mobile SDK only for capture/echo cancellation but forward PCM to our server which runs streaming STT/VAD; fallback to vendor API when GPU pool is saturated.

## Production Requirements

### Audio Transport

- Maintain existing websocket message format (`realtime_audio_chunk`) but allow ≤250 ms PCM frames so the server receives 64 KB chunks instead of 1 s buffers.
- Attach monotonic timestamps per chunk so server VAD can estimate speech onset regardless of network jitter.
- Preserve `isLast` to flush tail audio when the client stops speaking.

### Server-Side VAD

- Use lightweight VAD (WebRTC VAD, Silero VAD, Whisper tiny.en with transcribe-only) to gate Whisper decoding; run at 16 kHz mono for compatibility with current PCM pipeline.
- Target <150 ms VAD decision time; maintain hysteresis to avoid thrashing (mirrors client `speechConfirmationDuration` + `silenceDuration`).
- Emit `speech_started`/`speech_ended` events back to the client so UI indicators stay responsive even though detection moved server-side.

### Streaming STT Engine

- Support incremental decoding API: feed PCM frames, emit partial transcripts + confidence at least every 500 ms.
- Provide cancellation hook tied to existing `cancel_agent_request` so STT workers stop once the LLM aborts or the client leaves.
- Persist transcripts with timestamps for QA (store inside session DB / Claude history alongside audio hash for replays).

### Infrastructure & Scaling

- GPU pool sized for p95 concurrency: estimate 1 GPU per 6–8 concurrent Whisper-large-v3 streams (~1.3× RT factor) or 1 GPU per 20+ streams for medium models. Autoscale via K8s + node autoscaler.
- Co-locate STT workers with session servers to limit cross-AZ latency (<30 ms). If not possible, use Redis streams or NATS JetStream channels between websocket nodes and STT workers.
- Implement backpressure: queue depth per session ≤3 segments; drop/merge frames if the client sends faster than decoding rate.

### Reliability & Monitoring

- Emit metrics: `vad.latency`, `stt.decode_latency`, `stt.partial_count`, `stt.abort_reason`, GPU utilization, queue length.
- Alert when latency >500 ms or when transcription error rate spikes.
- Provide fallback to existing batch STT (current `sttManager.transcribe`) when streaming path fails; log structured reason for fallback.

### Security & Compliance

- Encrypt websocket transport (already using wss). For Whisper workers, enforce TLS/mTLS if deployed remotely.
- Scrub audio buffers after transcription, retain encrypted artifacts only when user opts-in for analytics.
- Document data retention + consent to satisfy GDPR/CCPA.

## Implementation Phases

1. **Prototype**
   - Spin up a single faster-whisper worker with WebSocket ingestion (python `faster_whisper/transcribe.py` streaming patch).
   - Update `Session.handleAudioChunk` to forward PCM frames directly to the worker and stream partial responses back via new `transcription_partial` events.
2. **Pilot**
   - Add server-side VAD gate ahead of Whisper worker (Silero). Instrument latencies and compare vs. client VAD logs.
   - Provide feature flag to switch cohorts between client-VAD (current) and server-VAD paths.
3. **Production**
   - Harden autoscaling, add health checks, implement failover + fallback STT.
   - Update mobile clients to disable Speechmatics dependency once server VAD is proven stable.

## Open Questions / Next Steps

- Which target accuracy/latency do we need to hit to sunset Speechmatics (e.g., <500 ms to first token, WER ≤10%)?
- Do we run Whisper ourselves or leverage a managed streaming STT provider for the first milestone?
- How do we ship echo cancellation without Speechmatics’ two-way audio SDK? (Options: RN `react-native-webrtc`, custom WebRTC SFU, or keep Speechmatics for playback only.)
- Need sizing study: record peak concurrent voice sessions per day and map to GPU requirements.
- Implementation tickets:
  1. Add streaming transport upgrades (chunk timestamps, ≤250 ms payloads).
  2. Build STT worker service (whisper + VAD) with health endpoints + metrics.
  3. Integrate new `transcription_partial`/`speech_state` events into the session + UI.
  4. Add fallback logic + feature flags.
