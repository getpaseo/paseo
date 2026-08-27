import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import pino from "pino";

import { DictationStreamManager } from "./dictation-stream-manager.js";
import { PersistedConfigSchema } from "../persisted-config.js";
import { resolveSpeechConfig } from "../speech/speech-config-resolver.js";
import type {
  SpeechToTextProvider,
  StreamingTranscriptionSession,
} from "../speech/speech-provider.js";

class FakeRealtimeSession extends EventEmitter implements StreamingTranscriptionSession {
  connected = false;
  appended: Buffer[] = [];
  commitCalls = 0;
  clearCalls = 0;
  closed = false;
  requiredSampleRate = 24000;

  async connect(): Promise<void> {
    this.connected = true;
  }

  appendPcm16(pcm16le: Buffer): void {
    this.appended.push(pcm16le);
  }

  commit(): void {
    this.commitCalls += 1;
  }

  clear(): void {
    this.clearCalls += 1;
  }

  close(): void {
    this.closed = true;
  }

  emitCommitted(segmentId: string): void {
    this.emit("committed", { segmentId, previousSegmentId: null });
  }

  emitTranscript(segmentId: string, transcript: string, isFinal: boolean): void {
    this.emit("transcript", { segmentId, transcript, isFinal });
  }

  emitError(message: string): void {
    this.emit("error", new Error(message));
  }
}

class FakeSttProvider implements SpeechToTextProvider {
  public readonly id = "fake";
  public lastLanguage?: string;
  constructor(private readonly session: FakeRealtimeSession) {}
  createSession(
    params: Parameters<SpeechToTextProvider["createSession"]>[0],
  ): StreamingTranscriptionSession {
    this.lastLanguage = params.language;
    return this.session;
  }
}

const buildPcmBase64 = (sampleValue: number, sampleCount: number): string => {
  const samples = new Int16Array(sampleCount);
  samples.fill(sampleValue);
  return Buffer.from(samples.buffer).toString("base64");
};

const tick = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("DictationStreamManager (finish buffer-too-small tolerance)", () => {
  const env = {
    dictationDebug: process.env.PASEO_DICTATION_DEBUG,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    process.env.PASEO_DICTATION_DEBUG = "false";
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env.PASEO_DICTATION_DEBUG = env.dictationDebug;
  });

  it("treats buffer-too-small as benign and finalizes with existing transcripts", async () => {
    const session = new FakeRealtimeSession();
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const manager = new DictationStreamManager({
      logger: pino({ level: "silent" }),
      emit: (msg) => emitted.push(msg),
      sessionId: "s1",
      stt: new FakeSttProvider(session),
      finalTimeoutMs: 5000,
    });

    await manager.handleStart("d1", "audio/pcm;rate=24000;bits=16");
    await manager.handleChunk({
      dictationId: "d1",
      seq: 0,
      audioBase64: buildPcmBase64(2000, 2400),
      format: "audio/pcm;rate=24000;bits=16",
    });

    session.emitTranscript("seg-1", "hello world", true);

    await manager.handleFinish("d1", 0);
    await tick();

    session.emitError(
      "Error committing input audio buffer: buffer too small. Expected at least 100ms of audio, but buffer only has 0.00ms of audio.",
    );
    await tick();

    const final = emitted.find((msg) => msg.type === "dictation_stream_final");
    const error = emitted.find((msg) => msg.type === "dictation_stream_error");
    expect(error).toBeUndefined();
    expect((final?.payload as { text?: string } | undefined)?.text).toBe("hello world");
    expect(session.closed).toBe(true);
  });
});

describe("DictationStreamManager (provider-agnostic provider)", () => {
  function resolveDictationLanguage(params: {
    env?: NodeJS.ProcessEnv;
    persisted?: unknown;
  }): string {
    const result = resolveSpeechConfig({
      paseoHome: "/tmp/paseo-home",
      env: params.env ?? ({} as NodeJS.ProcessEnv),
      persisted: PersistedConfigSchema.parse(params.persisted ?? {}),
    });
    return result.speech.sttLanguages.dictation;
  }

  async function startWithResolvedDictationLanguage(params: {
    env?: NodeJS.ProcessEnv;
    persisted?: unknown;
  }): Promise<FakeSttProvider> {
    const session = new FakeRealtimeSession();
    const sttProvider = new FakeSttProvider(session);
    const manager = new DictationStreamManager({
      logger: pino({ level: "silent" }),
      emit: () => {},
      sessionId: "s1",
      stt: sttProvider,
      language: resolveDictationLanguage(params),
    });

    await manager.handleStart("d-lang", "audio/pcm;rate=24000;bits=16");
    return sttProvider;
  }

  it("defaults to English when dictation language config is unset", async () => {
    const sttProvider = await startWithResolvedDictationLanguage({});

    expect(sttProvider.lastLanguage).toBe("en");
  });

  it("uses PASEO_DICTATION_LANGUAGE when set", async () => {
    const sttProvider = await startWithResolvedDictationLanguage({
      env: {
        PASEO_DICTATION_LANGUAGE: "pt",
      } as NodeJS.ProcessEnv,
    });

    expect(sttProvider.lastLanguage).toBe("pt");
  });

  it("treats empty PASEO_DICTATION_LANGUAGE as unset", async () => {
    const sttProvider = await startWithResolvedDictationLanguage({
      env: {
        PASEO_DICTATION_LANGUAGE: "  ",
      } as NodeJS.ProcessEnv,
    });

    expect(sttProvider.lastLanguage).toBe("en");
  });

  it("uses settings dictation STT language when env var is unset", async () => {
    const sttProvider = await startWithResolvedDictationLanguage({
      persisted: {
        features: {
          dictation: {
            stt: {
              language: "fr",
            },
          },
        },
      },
    });

    expect(sttProvider.lastLanguage).toBe("fr");
  });

  it("uses env dictation language over settings dictation STT language", async () => {
    const sttProvider = await startWithResolvedDictationLanguage({
      env: {
        PASEO_DICTATION_LANGUAGE: "pt",
      } as NodeJS.ProcessEnv,
      persisted: {
        features: {
          dictation: {
            stt: {
              language: "fr",
            },
          },
        },
      },
    });

    expect(sttProvider.lastLanguage).toBe("pt");
  });

  it("does not require OPENAI_API_KEY", async () => {
    const original = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      const session = new FakeRealtimeSession();
      const emitted: Array<{ type: string; payload: unknown }> = [];
      const manager = new DictationStreamManager({
        logger: pino({ level: "silent" }),
        emit: (msg) => emitted.push(msg),
        sessionId: "s1",
        stt: new FakeSttProvider(session),
      });

      await manager.handleStart("d-local", "audio/pcm;rate=16000;bits=16");

      expect(session.connected).toBe(true);
      expect(emitted.find((msg) => msg.type === "dictation_stream_error")).toBeUndefined();
    } finally {
      if (original !== undefined) {
        process.env.OPENAI_API_KEY = original;
      } else {
        delete process.env.OPENAI_API_KEY;
      }
    }
  });

  it("auto-commits while streaming and assembles final transcript in segment order", async () => {
    const originalDebug = process.env.PASEO_DICTATION_DEBUG;
    process.env.PASEO_DICTATION_DEBUG = "false";

    try {
      const session = new FakeRealtimeSession();
      const emitted: Array<{ type: string; payload: unknown }> = [];
      const manager = new DictationStreamManager({
        logger: pino({ level: "silent" }),
        emit: (msg) => emitted.push(msg),
        sessionId: "s1",
        stt: new FakeSttProvider(session),
        autoCommitSeconds: 1,
      });

      await manager.handleStart("d-segmented", "audio/pcm;rate=24000;bits=16");

      await manager.handleChunk({
        dictationId: "d-segmented",
        seq: 0,
        audioBase64: buildPcmBase64(2000, 24000),
        format: "audio/pcm;rate=24000;bits=16",
      });
      expect(session.commitCalls).toBe(1);

      session.emitCommitted("seg-1");
      session.emitTranscript("seg-1", "hello", true);

      await manager.handleChunk({
        dictationId: "d-segmented",
        seq: 1,
        audioBase64: buildPcmBase64(2000, 12000),
        format: "audio/pcm;rate=24000;bits=16",
      });

      await manager.handleFinish("d-segmented", 1);
      expect(session.commitCalls).toBe(2);

      session.emitCommitted("seg-2");
      session.emitTranscript("seg-2", "world", true);
      await tick();

      const final = emitted.find((msg) => msg.type === "dictation_stream_final");
      expect((final?.payload as { text?: string } | undefined)?.text).toBe("hello world");
    } finally {
      if (originalDebug === undefined) {
        delete process.env.PASEO_DICTATION_DEBUG;
      } else {
        process.env.PASEO_DICTATION_DEBUG = originalDebug;
      }
    }
  });

  it("adapts finish timeout based on pending committed segments", async () => {
    const session = new FakeRealtimeSession();
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const manager = new DictationStreamManager({
      logger: pino({ level: "silent" }),
      emit: (msg) => emitted.push(msg),
      sessionId: "s1",
      stt: new FakeSttProvider(session),
      finalTimeoutMs: 5000,
    });

    await manager.handleStart("d-timeout", "audio/pcm;rate=24000;bits=16");
    await manager.handleChunk({
      dictationId: "d-timeout",
      seq: 0,
      audioBase64: buildPcmBase64(2000, 2400),
      format: "audio/pcm;rate=24000;bits=16",
    });

    // Simulate a committed segment whose final transcript is still pending.
    session.emitCommitted("seg-pending");

    await manager.handleFinish("d-timeout", 0);

    const finishAccepted = emitted.find((msg) => msg.type === "dictation_stream_finish_accepted");
    expect(finishAccepted).toBeDefined();
    expect(
      (finishAccepted?.payload as { timeoutMs?: number } | undefined)?.timeoutMs,
    ).toBeGreaterThan(5000);
  });

  it("adapts finish timeout when only uncommitted non-final transcripts are pending", async () => {
    const session = new FakeRealtimeSession();
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const manager = new DictationStreamManager({
      logger: pino({ level: "silent" }),
      emit: (msg) => emitted.push(msg),
      sessionId: "s1",
      stt: new FakeSttProvider(session),
      finalTimeoutMs: 5000,
    });

    await manager.handleStart("d-uncommitted-timeout", "audio/pcm;rate=24000;bits=16");
    await manager.handleChunk({
      dictationId: "d-uncommitted-timeout",
      seq: 0,
      audioBase64: buildPcmBase64(2000, 2400),
      format: "audio/pcm;rate=24000;bits=16",
    });

    session.emitCommitted("seg-1");
    session.emitTranscript("seg-1", "hello", true);
    session.emitTranscript("seg-dangling", "hel", false);

    await manager.handleFinish("d-uncommitted-timeout", 0);

    const finishAccepted = emitted.find((msg) => msg.type === "dictation_stream_finish_accepted");
    expect(finishAccepted).toBeDefined();
    expect(
      (finishAccepted?.payload as { timeoutMs?: number } | undefined)?.timeoutMs,
    ).toBeGreaterThan(5000);
  });

  it("drops dangling uncommitted non-final transcripts when finishing after silence tail clear", async () => {
    vi.useFakeTimers();
    const previousDebug = process.env.PASEO_DICTATION_DEBUG;
    process.env.PASEO_DICTATION_DEBUG = "false";
    try {
      const session = new FakeRealtimeSession();
      const emitted: Array<{ type: string; payload: unknown }> = [];
      const manager = new DictationStreamManager({
        logger: pino({ level: "silent" }),
        emit: (msg) => emitted.push(msg),
        sessionId: "s1",
        stt: new FakeSttProvider(session),
        finalTimeoutMs: 5000,
      });

      await manager.handleStart("d-clear-tail", "audio/pcm;rate=24000;bits=16");
      await manager.handleChunk({
        dictationId: "d-clear-tail",
        seq: 0,
        audioBase64: buildPcmBase64(2000, 2400),
        format: "audio/pcm;rate=24000;bits=16",
      });

      session.emitCommitted("seg-1");
      session.emitTranscript("seg-1", "hello", true);

      await manager.handleChunk({
        dictationId: "d-clear-tail",
        seq: 1,
        audioBase64: buildPcmBase64(0, 2400),
        format: "audio/pcm;rate=24000;bits=16",
      });
      session.emitTranscript("seg-dangling", "", false);

      await manager.handleFinish("d-clear-tail", 1);
      await tick();
      await vi.advanceTimersByTimeAsync(5_100);
      await tick();

      const final = emitted.find((msg) => msg.type === "dictation_stream_final");
      const error = emitted.find((msg) => msg.type === "dictation_stream_error");
      expect(session.clearCalls).toBeGreaterThan(0);
      expect(error).toBeUndefined();
      expect((final?.payload as { text?: string } | undefined)?.text).toBe("hello");
    } finally {
      process.env.PASEO_DICTATION_DEBUG = previousDebug;
      vi.useRealTimers();
    }
  });
});

describe("DictationStreamManager (chunk and segment limits)", () => {
  const previousEnv = {
    debug: process.env.PASEO_DICTATION_DEBUG,
    maxChunk: process.env.PASEO_DICTATION_MAX_CHUNK_BYTES,
    hardSegment: process.env.PASEO_DICTATION_HARD_SEGMENT_BYTES,
  };

  beforeEach(() => {
    process.env.PASEO_DICTATION_DEBUG = "false";
    delete process.env.PASEO_DICTATION_MAX_CHUNK_BYTES;
    delete process.env.PASEO_DICTATION_HARD_SEGMENT_BYTES;
  });

  afterEach(() => {
    if (previousEnv.debug === undefined) {
      delete process.env.PASEO_DICTATION_DEBUG;
    } else {
      process.env.PASEO_DICTATION_DEBUG = previousEnv.debug;
    }
    if (previousEnv.maxChunk === undefined) {
      delete process.env.PASEO_DICTATION_MAX_CHUNK_BYTES;
    } else {
      process.env.PASEO_DICTATION_MAX_CHUNK_BYTES = previousEnv.maxChunk;
    }
    if (previousEnv.hardSegment === undefined) {
      delete process.env.PASEO_DICTATION_HARD_SEGMENT_BYTES;
    } else {
      process.env.PASEO_DICTATION_HARD_SEGMENT_BYTES = previousEnv.hardSegment;
    }
  });

  // Raw byte payloads (odd lengths included); bytes are non-zero.
  function buildBytesBase64(byteCount: number): string {
    const bytes = Buffer.alloc(byteCount);
    for (let i = 0; i < byteCount; i += 1) {
      bytes[i] = (i % 251) + 1;
    }
    return bytes.toString("base64");
  }

  function emittedErrors(messages: Array<{ type: string; payload: unknown }>) {
    return messages.filter((msg) => msg.type === "dictation_stream_error");
  }

  it("accepts a chunk that decodes to exactly maxChunkBytes", async () => {
    const session = new FakeRealtimeSession();
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const manager = new DictationStreamManager({
      logger: pino({ level: "silent" }),
      emit: (msg) => emitted.push(msg),
      sessionId: "s1",
      stt: new FakeSttProvider(session),
      autoCommitSeconds: 0,
      maxChunkBytes: 1024,
    });

    await manager.handleStart("d-exact", "audio/pcm;rate=24000;bits=16");
    await manager.handleChunk({
      dictationId: "d-exact",
      seq: 0,
      audioBase64: buildBytesBase64(1024),
      format: "audio/pcm;rate=24000;bits=16",
    });
    await tick();

    expect(session.appended).toHaveLength(1);
    expect(session.appended[0]?.length).toBe(1024);
    expect(emittedErrors(emitted)).toHaveLength(0);
    expect(emitted.at(-1)).toEqual({
      type: "dictation_stream_ack",
      payload: { dictationId: "d-exact", ackSeq: 0 },
    });
  });

  it("rejects a decoded chunk one byte over the limit even when its encoding passes the precheck", async () => {
    const session = new FakeRealtimeSession();
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const manager = new DictationStreamManager({
      logger: pino({ level: "silent" }),
      emit: (msg) => emitted.push(msg),
      sessionId: "s1",
      stt: new FakeSttProvider(session),
      autoCommitSeconds: 0,
      maxChunkBytes: 1024,
    });

    await manager.handleStart("d-over", "audio/pcm;rate=24000;bits=16");
    // 1025 bytes encode to 1368 chars — the same encoded length as the accepted
    // 1024-byte chunk above, so only the decoded-length check can catch it.
    await manager.handleChunk({
      dictationId: "d-over",
      seq: 0,
      audioBase64: buildBytesBase64(1025),
      format: "audio/pcm;rate=24000;bits=16",
    });
    await tick();

    expect(session.appended).toHaveLength(0);
    expect(session.closed).toBe(true);
    const errors = emittedErrors(emitted);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.payload).toEqual({
      dictationId: "d-over",
      error: expect.stringContaining("exceeds the 1024-byte limit"),
      retryable: true,
    });

    await manager.handleChunk({
      dictationId: "d-over",
      seq: 1,
      audioBase64: buildBytesBase64(16),
      format: "audio/pcm;rate=24000;bits=16",
    });
    await tick();

    const followUpErrors = emittedErrors(emitted);
    expect(followUpErrors).toHaveLength(2);
    expect(followUpErrors[1]?.payload).toEqual({
      dictationId: "d-over",
      error: "Dictation stream not started",
      retryable: true,
    });
  });

  it("rejects unbounded resampler amplification from an attacker-controlled sample rate", async () => {
    const session = new FakeRealtimeSession();
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const manager = new DictationStreamManager({
      logger: pino({ level: "silent" }),
      emit: (msg) => emitted.push(msg),
      sessionId: "s1",
      stt: new FakeSttProvider(session),
      autoCommitSeconds: 0,
    });

    await manager.handleStart("d-rate", "audio/pcm;rate=1;bits=16");
    await manager.handleChunk({
      dictationId: "d-rate",
      seq: 0,
      audioBase64: buildPcmBase64(2000, 2048),
      format: "audio/pcm;rate=1;bits=16",
    });
    await tick();

    expect(session.appended).toHaveLength(0);
    expect(session.closed).toBe(true);
    const errors = emittedErrors(emitted);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.payload).toEqual({
      dictationId: "d-rate",
      error: expect.stringContaining("exceeds the 9216-sample output limit"),
      retryable: false,
    });

    await manager.handleChunk({
      dictationId: "d-rate",
      seq: 1,
      audioBase64: buildPcmBase64(2000, 8),
      format: "audio/pcm;rate=1;bits=16",
    });
    await tick();
    expect(emittedErrors(emitted)).toHaveLength(2);
  });

  it("keeps the hard segment cap committing loud audio while finish waits for missing chunks", async () => {
    const session = new FakeRealtimeSession();
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const manager = new DictationStreamManager({
      logger: pino({ level: "silent" }),
      emit: (msg) => emitted.push(msg),
      sessionId: "s1",
      stt: new FakeSttProvider(session),
      autoCommitSeconds: 0,
      hardSegmentBytes: 480,
    });

    await manager.handleStart("d-finish-loud", "audio/pcm;rate=24000;bits=16");
    await manager.handleChunk({
      dictationId: "d-finish-loud",
      seq: 0,
      audioBase64: buildPcmBase64(2000, 1000),
      format: "audio/pcm;rate=24000;bits=16",
    });
    expect(session.commitCalls).toBe(1);

    await manager.handleFinish("d-finish-loud", 500);
    for (let seq = 1; seq <= 4; seq += 1) {
      await manager.handleChunk({
        dictationId: "d-finish-loud",
        seq,
        audioBase64: buildPcmBase64(2000, 1000),
        format: "audio/pcm;rate=24000;bits=16",
      });
    }

    expect(session.commitCalls).toBe(5);
    expect(session.clearCalls).toBe(0);
    expect(emittedErrors(emitted)).toHaveLength(0);
    expect(emitted.filter((msg) => msg.type === "dictation_stream_final")).toHaveLength(0);

    manager.cleanupAll();
    expect(session.closed).toBe(true);
  });

  it("keeps the hard segment cap clearing silent audio while finish waits for missing chunks", async () => {
    const session = new FakeRealtimeSession();
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const manager = new DictationStreamManager({
      logger: pino({ level: "silent" }),
      emit: (msg) => emitted.push(msg),
      sessionId: "s1",
      stt: new FakeSttProvider(session),
      autoCommitSeconds: 0,
      hardSegmentBytes: 480,
    });

    await manager.handleStart("d-finish-quiet", "audio/pcm;rate=24000;bits=16");
    await manager.handleChunk({
      dictationId: "d-finish-quiet",
      seq: 0,
      audioBase64: buildPcmBase64(10, 1000),
      format: "audio/pcm;rate=24000;bits=16",
    });
    expect(session.clearCalls).toBe(1);

    await manager.handleFinish("d-finish-quiet", 500);
    for (let seq = 1; seq <= 3; seq += 1) {
      await manager.handleChunk({
        dictationId: "d-finish-quiet",
        seq,
        audioBase64: buildPcmBase64(10, 1000),
        format: "audio/pcm;rate=24000;bits=16",
      });
    }

    expect(session.clearCalls).toBe(4);
    expect(session.commitCalls).toBe(0);
    expect(emittedErrors(emitted)).toHaveLength(0);

    manager.cleanupAll();
  });

  it("accepts a chunk at the sequence window edge and fails past it", async () => {
    const session = new FakeRealtimeSession();
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const manager = new DictationStreamManager({
      logger: pino({ level: "silent" }),
      emit: (msg) => emitted.push(msg),
      sessionId: "s1",
      stt: new FakeSttProvider(session),
      autoCommitSeconds: 0,
    });

    await manager.handleStart("d-window", "audio/pcm;rate=24000;bits=16");
    await manager.handleChunk({
      dictationId: "d-window",
      seq: 4095,
      audioBase64: buildPcmBase64(1000, 2),
      format: "audio/pcm;rate=24000;bits=16",
    });
    expect(emittedErrors(emitted)).toHaveLength(0);

    await manager.handleChunk({
      dictationId: "d-window",
      seq: 4096,
      audioBase64: buildPcmBase64(1000, 2),
      format: "audio/pcm;rate=24000;bits=16",
    });
    await tick();

    expect(session.closed).toBe(true);
    const errors = emittedErrors(emitted);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.payload).toEqual({
      dictationId: "d-window",
      error: expect.stringContaining("reorder buffer limit exceeded"),
      retryable: true,
    });
  });

  it("fails once more than the reorder entry cap buffers behind a gap", async () => {
    const session = new FakeRealtimeSession();
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const manager = new DictationStreamManager({
      logger: pino({ level: "silent" }),
      emit: (msg) => emitted.push(msg),
      sessionId: "s1",
      stt: new FakeSttProvider(session),
      autoCommitSeconds: 0,
    });

    await manager.handleStart("d-entries", "audio/pcm;rate=24000;bits=16");
    for (let seq = 1; seq <= 512; seq += 1) {
      await manager.handleChunk({
        dictationId: "d-entries",
        seq,
        audioBase64: buildPcmBase64(1000, 2),
        format: "audio/pcm;rate=24000;bits=16",
      });
    }
    expect(emittedErrors(emitted)).toHaveLength(0);

    await manager.handleChunk({
      dictationId: "d-entries",
      seq: 513,
      audioBase64: buildPcmBase64(1000, 2),
      format: "audio/pcm;rate=24000;bits=16",
    });
    await tick();

    expect(session.closed).toBe(true);
    const errors = emittedErrors(emitted);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.payload).toEqual({
      dictationId: "d-entries",
      error: expect.stringContaining("buffered=512 entries"),
      retryable: true,
    });
  });

  it("fails once buffered reorder bytes exceed the byte cap", async () => {
    const session = new FakeRealtimeSession();
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const manager = new DictationStreamManager({
      logger: pino({ level: "silent" }),
      emit: (msg) => emitted.push(msg),
      sessionId: "s1",
      stt: new FakeSttProvider(session),
      autoCommitSeconds: 0,
      maxChunkBytes: 1024 * 1024,
    });

    await manager.handleStart("d-bytes", "audio/pcm;rate=24000;bits=16");
    for (let seq = 1; seq <= 16; seq += 1) {
      await manager.handleChunk({
        dictationId: "d-bytes",
        seq,
        audioBase64: Buffer.alloc(1024 * 1024, 7).toString("base64"),
        format: "audio/pcm;rate=24000;bits=16",
      });
    }
    expect(emittedErrors(emitted)).toHaveLength(0);

    await manager.handleChunk({
      dictationId: "d-bytes",
      seq: 17,
      audioBase64: Buffer.alloc(1024 * 1024, 7).toString("base64"),
      format: "audio/pcm;rate=24000;bits=16",
    });
    await tick();

    expect(session.closed).toBe(true);
    const errors = emittedErrors(emitted);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.payload).toEqual({
      dictationId: "d-bytes",
      error: expect.stringContaining("16777216 bytes"),
      retryable: true,
    });
  }, 20000);

  it("prefers explicit constructor limits over environment values", async () => {
    process.env.PASEO_DICTATION_MAX_CHUNK_BYTES = "999999";
    const session = new FakeRealtimeSession();
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const manager = new DictationStreamManager({
      logger: pino({ level: "silent" }),
      emit: (msg) => emitted.push(msg),
      sessionId: "s1",
      stt: new FakeSttProvider(session),
      autoCommitSeconds: 0,
      maxChunkBytes: 64,
    });

    await manager.handleStart("d-config", "audio/pcm;rate=24000;bits=16");
    await manager.handleChunk({
      dictationId: "d-config",
      seq: 0,
      audioBase64: buildBytesBase64(65),
      format: "audio/pcm;rate=24000;bits=16",
    });
    await tick();

    const errors = emittedErrors(emitted);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.payload).toEqual({
      dictationId: "d-config",
      error: expect.stringContaining("exceeds the 64-byte limit"),
      retryable: true,
    });
  });

  it("falls back to default limits when environment values are invalid", async () => {
    process.env.PASEO_DICTATION_MAX_CHUNK_BYTES = "not-a-number";
    process.env.PASEO_DICTATION_HARD_SEGMENT_BYTES = "junk";
    const session = new FakeRealtimeSession();
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const manager = new DictationStreamManager({
      logger: pino({ level: "silent" }),
      emit: (msg) => emitted.push(msg),
      sessionId: "s1",
      stt: new FakeSttProvider(session),
      autoCommitSeconds: 0,
    });

    await manager.handleStart("d-defaults", "audio/pcm;rate=24000;bits=16");
    await manager.handleChunk({
      dictationId: "d-defaults",
      seq: 0,
      audioBase64: buildPcmBase64(2000, 1000),
      format: "audio/pcm;rate=24000;bits=16",
    });

    // Defaults applied (512KiB chunk cap, ~1.9MiB hard segment): a 2000-byte loud
    // chunk forwards without tripping either limit or a broken zero/negative cap.
    expect(session.appended).toHaveLength(1);
    expect(session.commitCalls).toBe(0);
    expect(session.clearCalls).toBe(0);
    expect(emittedErrors(emitted)).toHaveLength(0);
  });

  it("falls back to resolved defaults when explicit constructor limits are invalid", async () => {
    const session = new FakeRealtimeSession();
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const manager = new DictationStreamManager({
      logger: pino({ level: "silent" }),
      emit: (msg) => emitted.push(msg),
      sessionId: "s1",
      stt: new FakeSttProvider(session),
      autoCommitSeconds: 0,
      maxChunkBytes: 0,
      hardSegmentBytes: -480,
    });

    await manager.handleStart("d-invalid-limits", "audio/pcm;rate=24000;bits=16");
    await manager.handleChunk({
      dictationId: "d-invalid-limits",
      seq: 0,
      audioBase64: buildPcmBase64(2000, 1000),
      format: "audio/pcm;rate=24000;bits=16",
    });

    // A literal zero chunk cap would reject every chunk and a negative hard cap
    // would commit immediately; both fall back to the defaults instead.
    expect(session.appended).toHaveLength(1);
    expect(session.commitCalls).toBe(0);
    expect(emittedErrors(emitted)).toHaveLength(0);
  });

  it("uses the default for a fractional explicit limit", async () => {
    const session = new FakeRealtimeSession();
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const manager = new DictationStreamManager({
      logger: pino({ level: "silent" }),
      emit: (msg) => emitted.push(msg),
      sessionId: "s1",
      stt: new FakeSttProvider(session),
      autoCommitSeconds: 0,
      maxChunkBytes: 1.5,
    });

    await manager.handleStart("d-fractional-limit", "audio/pcm;rate=24000;bits=16");
    await manager.handleChunk({
      dictationId: "d-fractional-limit",
      seq: 0,
      audioBase64: buildPcmBase64(2000, 1000),
      format: "audio/pcm;rate=24000;bits=16",
    });

    expect(session.appended).toHaveLength(1);
    expect(emittedErrors(emitted)).toHaveLength(0);
  });
});
