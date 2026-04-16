# FunASR STT Provider Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Fun-ASR-Nano-2512 as a new STT provider so Paseo can transcribe Chinese (with mixed English) speech via a standalone Python server.

**Architecture:** A lightweight FastAPI Python server wraps FunASR's `AutoModel` and exposes `POST /transcribe`. A new `"funasr"` STT provider in the Paseo daemon sends audio to this server via HTTP. The Python server runs on port 10095, completely independent of the daemon on 6767.

**Tech Stack:** Python (FastAPI + uvicorn + funasr), TypeScript (Paseo server provider)

---

### Task 1: Python FunASR Server

**Files:**
- Create: `packages/funasr-server/server.py`
- Create: `packages/funasr-server/requirements.txt`

**Step 1: Create requirements.txt**

```
funasr
fastapi
uvicorn
python-multipart
```

**Step 2: Create server.py**

```python
import io
import logging
import wave
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse

logger = logging.getLogger("funasr-server")

model = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global model
    from funasr import AutoModel

    logger.info("Loading Fun-ASR-Nano-2512 model...")
    model = AutoModel(model="FunAudioLLM/Fun-ASR-Nano-2512")
    logger.info("Model loaded successfully")
    yield
    model = None


app = FastAPI(lifespan=lifespan)


@app.get("/health")
async def health():
    return {"status": "ok", "model_loaded": model is not None}


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    if model is None:
        return JSONResponse(status_code=503, content={"error": "Model not loaded"})

    audio_bytes = await file.read()
    content_type = file.content_type or ""

    # If raw PCM, wrap in WAV header (16kHz mono 16-bit assumed)
    if "pcm" in content_type.lower() or file.filename == "audio.pcm":
        sample_rate = 16000
        wav_buf = io.BytesIO()
        with wave.open(wav_buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sample_rate)
            wf.writeframes(audio_bytes)
        audio_bytes = wav_buf.getvalue()

    # Write to temp buffer for funasr
    result = model.generate(input=audio_bytes, batch_size_s=300)

    if not result or len(result) == 0:
        return {"text": "", "language": ""}

    entry = result[0]
    text = entry.get("text", "")

    return {"text": text}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    uvicorn.run(app, host="127.0.0.1", port=10095)
```

**Step 3: Test the server manually**

```bash
cd packages/funasr-server
pip install -r requirements.txt
python server.py
# In another terminal:
curl http://127.0.0.1:10095/health
# Expected: {"status":"ok","model_loaded":true}
```

**Step 4: Commit**

```bash
git add packages/funasr-server/
git commit -m "feat: add standalone FunASR Python server for Chinese STT"
```

---

### Task 2: Add "funasr" to SpeechProviderIdSchema

This registers "funasr" as a valid provider ID across the config system.

**Files:**
- Modify: `packages/server/src/server/speech/speech-types.ts:3`
- Modify: `packages/server/src/server/persisted-config.ts:60-64`

**Step 1: Write the failing test**

Add a test case to `packages/server/src/server/speech/speech-config-resolver.test.ts`:

```typescript
test("resolves funasr provider for dictation", () => {
  const persisted = PersistedConfigSchema.parse({
    features: {
      dictation: {
        stt: { provider: "funasr" },
      },
    },
  });
  const env = {
    PASEO_FUNASR_URL: "http://127.0.0.1:10095",
  } as NodeJS.ProcessEnv;

  const result = resolveSpeechConfig({
    paseoHome: "/tmp/paseo-home",
    env,
    persisted,
  });

  expect(result.speech.providers.dictationStt).toEqual({
    provider: "funasr",
    explicit: true,
    enabled: true,
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/server && npx vitest run src/server/speech/speech-config-resolver.test.ts`
Expected: FAIL — Zod validation rejects "funasr" as invalid enum value.

**Step 3: Update the schemas**

In `packages/server/src/server/speech/speech-types.ts:3`, change:
```typescript
// Before:
export const SpeechProviderIdSchema = z.enum(["openai", "local"]);
// After:
export const SpeechProviderIdSchema = z.enum(["openai", "local", "funasr"]);
```

In `packages/server/src/server/persisted-config.ts:60-64`, change:
```typescript
// Before:
const SpeechProviderIdSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(["openai", "local"]));
// After:
const SpeechProviderIdSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(["openai", "local", "funasr"]));
```

In `packages/server/src/server/speech/speech-config-resolver.ts`, update `RequestedSpeechProvidersSchema` defaults to keep "local" as default (no change needed — defaults are already `"local"`, the schema just needs to accept "funasr" which it will inherit from the updated `SpeechProviderIdSchema` import).

But note: `speech-config-resolver.ts` imports from `speech-types.ts` and also has its own `OptionalSpeechProviderSchema` at line 13 that pipes through the same `SpeechProviderIdSchema` from `speech-types.ts`. This will automatically pick up "funasr" once `speech-types.ts` is updated.

However, `persisted-config.ts` has its **own local copy** of `SpeechProviderIdSchema` at line 60 — this must also be updated.

**Step 4: Run test to verify it passes**

Run: `cd packages/server && npx vitest run src/server/speech/speech-config-resolver.test.ts`
Expected: PASS

**Step 5: Run typecheck**

Run: `cd packages/server && npx tsc --noEmit`
Expected: PASS (TypeScript will need the `SpeechProviderId` union to include "funasr")

**Step 6: Commit**

```bash
git add packages/server/src/server/speech/speech-types.ts packages/server/src/server/persisted-config.ts packages/server/src/server/speech/speech-config-resolver.test.ts
git commit -m "feat: register funasr as valid speech provider ID"
```

---

### Task 3: FunASR STT Provider Implementation

**Files:**
- Create: `packages/server/src/server/speech/providers/funasr/stt.ts`
- Create: `packages/server/src/server/speech/providers/funasr/stt.test.ts`
- Create: `packages/server/src/server/speech/providers/funasr/config.ts`

**Step 1: Write the test**

Create `packages/server/src/server/speech/providers/funasr/stt.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import pino from "pino";

import { FunASRSTT } from "./stt.js";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("FunASRSTT", () => {
  const logger = pino({ level: "silent" });

  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("has provider id 'funasr'", () => {
    const stt = new FunASRSTT({ url: "http://127.0.0.1:10095" }, logger);
    expect(stt.id).toBe("funasr");
  });

  it("creates a session that transcribes audio on commit", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: "你好世界" }),
    });

    const stt = new FunASRSTT({ url: "http://127.0.0.1:10095" }, logger);
    const session = stt.createSession({ logger });

    const transcripts: Array<{ transcript: string; isFinal: boolean }> = [];
    const committed: string[] = [];

    session.on("transcript", (payload) => transcripts.push(payload));
    session.on("committed", (payload) => committed.push(payload.segmentId));

    await session.connect();
    session.appendPcm16(Buffer.alloc(4800)); // some audio
    session.commit();

    // Wait for async commit to resolve
    await new Promise((r) => setTimeout(r, 50));

    expect(committed).toHaveLength(1);
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0].transcript).toBe("你好世界");
    expect(transcripts[0].isFinal).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("emits error when server is unreachable", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const stt = new FunASRSTT({ url: "http://127.0.0.1:10095" }, logger);
    const session = stt.createSession({ logger });

    const errors: Error[] = [];
    session.on("error", (err) => errors.push(err));

    await session.connect();
    session.appendPcm16(Buffer.alloc(100));
    session.commit();

    await new Promise((r) => setTimeout(r, 50));

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("ECONNREFUSED");
  });

  it("emits empty transcript for empty audio", async () => {
    const stt = new FunASRSTT({ url: "http://127.0.0.1:10095" }, logger);
    const session = stt.createSession({ logger });

    const transcripts: Array<{ transcript: string; isFinal: boolean }> = [];
    session.on("transcript", (payload) => transcripts.push(payload));
    session.on("committed", () => {});

    await session.connect();
    // commit with no audio
    session.commit();

    await new Promise((r) => setTimeout(r, 50));

    expect(transcripts).toHaveLength(1);
    expect(transcripts[0].transcript).toBe("");
    expect(transcripts[0].isFinal).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/server && npx vitest run src/server/speech/providers/funasr/stt.test.ts`
Expected: FAIL — module not found

**Step 3: Create config.ts**

Create `packages/server/src/server/speech/providers/funasr/config.ts`:

```typescript
import type { PersistedConfig } from "../../../persisted-config.js";

export type FunASRConfig = {
  url: string;
  timeoutMs?: number;
};

const DEFAULT_FUNASR_URL = "http://127.0.0.1:10095";
const DEFAULT_FUNASR_TIMEOUT_MS = 30000;

export function resolveFunASRConfig(params: {
  env: NodeJS.ProcessEnv;
  persisted: PersistedConfig;
}): FunASRConfig | undefined {
  const url =
    params.env.PASEO_FUNASR_URL ??
    (params.persisted.providers as any)?.funasr?.url ??
    DEFAULT_FUNASR_URL;

  return {
    url,
    timeoutMs: DEFAULT_FUNASR_TIMEOUT_MS,
  };
}
```

**Step 4: Create stt.ts**

Create `packages/server/src/server/speech/providers/funasr/stt.ts`:

```typescript
import { EventEmitter } from "node:events";
import { v4 as uuidv4 } from "uuid";
import type pino from "pino";

import type {
  SpeechToTextProvider,
  StreamingTranscriptionSession,
} from "../../speech-provider.js";

export type FunASRSTTConfig = {
  url: string;
  timeoutMs?: number;
};

export class FunASRSTT implements SpeechToTextProvider {
  public readonly id = "funasr" as const;
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly logger: pino.Logger;

  constructor(config: FunASRSTTConfig, parentLogger: pino.Logger) {
    this.url = config.url.replace(/\/+$/, "");
    this.timeoutMs = config.timeoutMs ?? 30000;
    this.logger = parentLogger.child({
      module: "speech",
      provider: "funasr",
      component: "stt",
    });
    this.logger.info({ url: this.url }, "FunASR STT initialized");
  }

  public createSession(params: {
    logger: pino.Logger;
    language?: string;
    prompt?: string;
  }): StreamingTranscriptionSession {
    const emitter = new EventEmitter();
    const requiredSampleRate = 16000;
    let connected = false;
    let segmentId = uuidv4();
    let previousSegmentId: string | null = null;
    let pcm16: Buffer = Buffer.alloc(0);

    const transcribeViaHttp = this.transcribeBuffer.bind(this);

    return {
      requiredSampleRate,
      async connect() {
        connected = true;
      },
      appendPcm16(chunk: Buffer) {
        if (!connected) {
          (emitter as any).emit(
            "error",
            new Error("FunASR STT session not connected"),
          );
          return;
        }
        pcm16 = pcm16.length === 0 ? chunk : Buffer.concat([pcm16, chunk]);
      },
      commit() {
        if (!connected) {
          (emitter as any).emit(
            "error",
            new Error("FunASR STT session not connected"),
          );
          return;
        }

        const committedId = segmentId;
        const prev = previousSegmentId;
        (emitter as any).emit("committed", {
          segmentId: committedId,
          previousSegmentId: prev,
        });

        const audioToSend = pcm16;
        previousSegmentId = committedId;
        segmentId = uuidv4();
        pcm16 = Buffer.alloc(0);

        if (audioToSend.length === 0) {
          (emitter as any).emit("transcript", {
            segmentId: committedId,
            transcript: "",
            isFinal: true,
            isLowConfidence: true,
          });
          return;
        }

        void (async () => {
          try {
            const text = await transcribeViaHttp(audioToSend, requiredSampleRate);
            (emitter as any).emit("transcript", {
              segmentId: committedId,
              transcript: text,
              isFinal: true,
              ...(text.length === 0 ? { isLowConfidence: true } : {}),
            });
          } catch (err) {
            (emitter as any).emit("error", err);
          }
        })();
      },
      clear() {
        pcm16 = Buffer.alloc(0);
        segmentId = uuidv4();
      },
      close() {
        connected = false;
        pcm16 = Buffer.alloc(0);
      },
      on(event: any, handler: any) {
        emitter.on(event, handler);
        return undefined;
      },
    };
  }

  private async transcribeBuffer(
    pcm16le: Buffer,
    sampleRate: number,
  ): Promise<string> {
    // Build WAV from PCM16
    const wavBuffer = this.pcm16ToWav(pcm16le, sampleRate);

    const formData = new FormData();
    const blob = new Blob([wavBuffer], { type: "audio/wav" });
    formData.append("file", blob, "audio.wav");

    const response = await fetch(`${this.url}/transcribe`, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `FunASR server returned ${response.status}: ${body}`,
      );
    }

    const result = (await response.json()) as { text?: string };
    return (result.text ?? "").trim();
  }

  private pcm16ToWav(pcm16le: Buffer, sampleRate: number): Buffer {
    const headerSize = 44;
    const channels = 1;
    const bitsPerSample = 16;
    const byteRate = (sampleRate * channels * bitsPerSample) / 8;
    const blockAlign = (channels * bitsPerSample) / 8;
    const wavBuffer = Buffer.alloc(headerSize + pcm16le.length);

    wavBuffer.write("RIFF", 0);
    wavBuffer.writeUInt32LE(36 + pcm16le.length, 4);
    wavBuffer.write("WAVE", 8);
    wavBuffer.write("fmt ", 12);
    wavBuffer.writeUInt32LE(16, 16);
    wavBuffer.writeUInt16LE(1, 20);
    wavBuffer.writeUInt16LE(channels, 22);
    wavBuffer.writeUInt32LE(sampleRate, 24);
    wavBuffer.writeUInt32LE(byteRate, 28);
    wavBuffer.writeUInt16LE(blockAlign, 32);
    wavBuffer.writeUInt16LE(bitsPerSample, 34);
    wavBuffer.write("data", 36);
    wavBuffer.writeUInt32LE(pcm16le.length, 40);
    pcm16le.copy(wavBuffer, 44);

    return wavBuffer;
  }
}
```

**Step 5: Run test to verify it passes**

Run: `cd packages/server && npx vitest run src/server/speech/providers/funasr/stt.test.ts`
Expected: PASS

**Step 6: Run typecheck**

Run: `npm run typecheck`

**Step 7: Commit**

```bash
git add packages/server/src/server/speech/providers/funasr/
git commit -m "feat: implement FunASR STT provider with HTTP transport"
```

---

### Task 4: Wire FunASR into Speech Runtime

**Files:**
- Modify: `packages/server/src/server/speech/speech-config-resolver.ts`
- Modify: `packages/server/src/server/speech/speech-runtime.ts`
- Modify: `packages/server/src/server/bootstrap.ts` (add FunASR config to PaseoDaemonConfig)

**Step 1: Add FunASR config resolution to speech-config-resolver.ts**

At top of `speech-config-resolver.ts`, add import:
```typescript
import { resolveFunASRConfig, type FunASRConfig } from "./providers/funasr/config.js";
```

Update the `resolveSpeechConfig` return type and body to include funasr config:
```typescript
export function resolveSpeechConfig(params: {
  paseoHome: string;
  env: NodeJS.ProcessEnv;
  persisted: PersistedConfig;
}): {
  openai: PaseoOpenAIConfig | undefined;
  speech: PaseoSpeechConfig;
  funasr: FunASRConfig | undefined;
} {
  // ... existing code ...

  const needsFunASR =
    providers.dictationStt.provider === "funasr" ||
    providers.voiceStt.provider === "funasr";
  const funasr = needsFunASR
    ? resolveFunASRConfig({ env: params.env, persisted: params.persisted })
    : undefined;

  return {
    openai,
    speech: { providers, ...(local.local ? { local: local.local } : {}) },
    funasr,
  };
}
```

**Step 2: Update bootstrap.ts to pass FunASR config through**

Add to `PaseoDaemonConfig`:
```typescript
import type { FunASRConfig } from "./speech/providers/funasr/config.js";
// In PaseoDaemonConfig type:
funasr?: FunASRConfig;
```

**Step 3: Wire into speech-runtime.ts reconcileServices**

In `createSpeechService`, accept optional `funasrConfig`:
```typescript
export function createSpeechService(params: {
  logger: Logger;
  openaiConfig?: PaseoOpenAIConfig;
  speechConfig?: PaseoSpeechConfig;
  funasrConfig?: FunASRConfig;
}): SpeechService {
```

In `reconcileServices()`, after the OpenAI step, add FunASR overlay:

```typescript
import { FunASRSTT } from "./providers/funasr/stt.js";
import type { FunASRConfig } from "./providers/funasr/config.js";

// Inside reconcileServices, after initializeOpenAiSpeechServices:
const funasrConfig = params.funasrConfig;
if (funasrConfig) {
  const funasrStt = new FunASRSTT(funasrConfig, logger);
  if (
    providers.dictationStt.enabled !== false &&
    providers.dictationStt.provider === "funasr" &&
    !nextOpenAiSpeech.dictationSttService
  ) {
    dictationSttService = funasrStt;
  }
  if (
    providers.voiceStt.enabled !== false &&
    providers.voiceStt.provider === "funasr" &&
    !nextOpenAiSpeech.sttService
  ) {
    sttService = funasrStt;
  }
}
```

**Step 4: Update the test for speech-config-resolver**

The existing test from Task 2 should already pass. Run the full suite:

Run: `cd packages/server && npx vitest run src/server/speech/`
Expected: PASS

**Step 5: Run typecheck**

Run: `npm run typecheck`

**Step 6: Commit**

```bash
git add packages/server/src/server/speech/ packages/server/src/server/bootstrap.ts
git commit -m "feat: wire FunASR provider into speech runtime reconciliation"
```

---

### Task 5: Remove Hardcoded Language for FunASR

FunASR Nano auto-detects language; it should not receive `language: "en"`.

**Files:**
- Modify: `packages/server/src/server/agent/stt-manager.ts:92`
- Modify: `packages/server/src/server/dictation/dictation-stream-manager.ts:179`

**Step 1: Update stt-manager.ts**

At line 92, change:
```typescript
// Before:
language: "en",
// After:
...(stt.id === "funasr" ? {} : { language: "en" }),
```

**Step 2: Update dictation-stream-manager.ts**

At line 179, change:
```typescript
// Before:
language: "en",
// After:
...(sttProvider.id === "funasr" ? {} : { language: "en" }),
```

**Step 3: Run existing tests**

Run: `cd packages/server && npx vitest run src/server/agent/stt-manager.test.ts src/server/dictation/dictation-stream-manager.test.ts`
Expected: PASS (existing tests use fake providers with id "fake", not "funasr")

**Step 4: Run typecheck**

Run: `npm run typecheck`

**Step 5: Commit**

```bash
git add packages/server/src/server/agent/stt-manager.ts packages/server/src/server/dictation/dictation-stream-manager.ts
git commit -m "feat: skip language hint for FunASR provider (auto-detects)"
```

---

### Task 6: Integration Test — End-to-End Verification

**Step 1: Start the FunASR Python server**

```bash
cd packages/funasr-server
python server.py &
# Wait for "Model loaded successfully"
curl http://127.0.0.1:10095/health
# Expected: {"status":"ok","model_loaded":true}
```

**Step 2: Run the Paseo daemon with funasr provider**

```bash
PASEO_DICTATION_STT_PROVIDER=funasr PASEO_LISTEN=127.0.0.1:6868 npm run cli -- daemon start --foreground
```

Note: Using port 6868 to avoid conflicting with the existing daemon on 6767.

**Step 3: Run typecheck one final time**

Run: `npm run typecheck`
Expected: PASS

**Step 4: Final commit (if any remaining changes)**

```bash
git add -A
git commit -m "feat: FunASR Chinese STT provider — complete integration"
```
