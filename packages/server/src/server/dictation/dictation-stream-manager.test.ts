import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import pino from "pino";

import {
  DictationStreamManager,
} from "./dictation-stream-manager.js";
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
  constructor(private readonly session: FakeRealtimeSession) {}
  createSession(_params: { logger: any; language?: string; prompt?: string }): StreamingTranscriptionSession {
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
    const emitted: Array<{ type: string; payload: any }> = [];
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
      "Error committing input audio buffer: buffer too small. Expected at least 100ms of audio, but buffer only has 0.00ms of audio."
    );
    await tick();

    const final = emitted.find((msg) => msg.type === "dictation_stream_final");
    const error = emitted.find((msg) => msg.type === "dictation_stream_error");
    expect(error).toBeUndefined();
    expect(final?.payload.text).toBe("hello world");
    expect(session.closed).toBe(true);
  });
});

describe("DictationStreamManager (provider-agnostic provider)", () => {
  it("does not require OPENAI_API_KEY", async () => {
    const original = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      const session = new FakeRealtimeSession();
      const emitted: Array<{ type: string; payload: any }> = [];
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
      const emitted: Array<{ type: string; payload: any }> = [];
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
      expect(final?.payload.text).toBe("hello world");
    } finally {
      if (originalDebug === undefined) {
        delete process.env.PASEO_DICTATION_DEBUG;
      } else {
        process.env.PASEO_DICTATION_DEBUG = originalDebug;
      }
    }
  });
});
