import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import pino from "pino";

import {
  DictationStreamManager,
  type RealtimeTranscriptionSession,
  type RealtimeTranscriptionSessionFactory,
} from "./dictation-stream-manager.js";

class FakeRealtimeSession extends EventEmitter implements RealtimeTranscriptionSession {
  connected = false;
  appended: string[] = [];
  commitCalls = 0;
  clearCalls = 0;
  closed = false;

  async connect(): Promise<void> {
    this.connected = true;
  }

  appendPcm16Base64(base64Audio: string): void {
    this.appended.push(base64Audio);
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

  emitCommitted(itemId: string): void {
    this.emit("committed", { itemId, previousItemId: null });
  }

  emitTranscript(itemId: string, transcript: string, isFinal: boolean): void {
    this.emit("transcript", { itemId, transcript, isFinal });
  }

  emitError(message: string): void {
    this.emit("error", new Error(message));
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

describe("DictationStreamManager (semantic VAD grace fallback)", () => {
  const env = {
    turnDetection: process.env.OPENAI_REALTIME_DICTATION_TURN_DETECTION,
    dictationDebug: process.env.PASEO_DICTATION_DEBUG,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    process.env.OPENAI_REALTIME_DICTATION_TURN_DETECTION = "semantic_vad";
    process.env.PASEO_DICTATION_DEBUG = "false";
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env.OPENAI_REALTIME_DICTATION_TURN_DETECTION = env.turnDetection;
    process.env.PASEO_DICTATION_DEBUG = env.dictationDebug;
  });

  it("treats buffer-too-small as benign and finalizes with existing transcripts", async () => {
    const session = new FakeRealtimeSession();
    const factory: RealtimeTranscriptionSessionFactory = () => session;
    const emitted: Array<{ type: string; payload: any }> = [];
    const manager = new DictationStreamManager({
      logger: pino({ level: "silent" }),
      emit: (msg) => emitted.push(msg),
      sessionId: "s1",
      openaiApiKey: "k",
      sessionFactory: factory,
      finalTimeoutMs: 5000,
    });

    await manager.handleStart("d1", "audio/pcm;rate=24000;bits=16");
    await manager.handleChunk({
      dictationId: "d1",
      seq: 0,
      audioBase64: buildPcmBase64(2000, 2400),
      format: "audio/pcm;rate=24000;bits=16",
    });

    session.emitTranscript("i1", "hello world", true);

    await manager.handleFinish("d1", 0);
    await tick();

    vi.advanceTimersByTime(2000);
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

  it("does not fallback-commit if committed event arrives during grace window", async () => {
    const session = new FakeRealtimeSession();
    const factory: RealtimeTranscriptionSessionFactory = () => session;
    const emitted: Array<{ type: string; payload: any }> = [];
    const manager = new DictationStreamManager({
      logger: pino({ level: "silent" }),
      emit: (msg) => emitted.push(msg),
      sessionId: "s1",
      openaiApiKey: "k",
      sessionFactory: factory,
      finalTimeoutMs: 5000,
    });

    await manager.handleStart("d1", "audio/pcm;rate=24000;bits=16");
    await manager.handleChunk({
      dictationId: "d1",
      seq: 0,
      audioBase64: buildPcmBase64(2000, 2400),
      format: "audio/pcm;rate=24000;bits=16",
    });

    await manager.handleFinish("d1", 0);
    session.emitCommitted("i1");
    session.emitTranscript("i1", "hi there", true);

    vi.advanceTimersByTime(2000);
    await tick();

    expect(session.commitCalls).toBe(0);
    const final = emitted.find((msg) => msg.type === "dictation_stream_final");
    expect(final?.payload.text).toBe("hi there");
  });
});
