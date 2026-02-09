import { describe, expect, it } from "vitest";
import pino from "pino";
import { EventEmitter } from "node:events";

import { STTManager } from "./stt-manager.js";
import type {
  SpeechToTextProvider,
  StreamingTranscriptionSession,
  TranscriptionResult,
} from "../speech/speech-provider.js";

class FakeStt implements SpeechToTextProvider {
  public readonly id = "fake";
  constructor(private readonly result: TranscriptionResult) {}

  createSession(_params: {
    logger: any;
    language?: string;
    prompt?: string;
  }): StreamingTranscriptionSession {
    const emitter = new EventEmitter();
    const result = this.result;
    let segmentId = "seg-1";
    let previousSegmentId: string | null = null;

    return {
      requiredSampleRate: 24000,
      async connect() {},
      appendPcm16() {},
      commit() {
        (emitter as any).emit("committed", { segmentId, previousSegmentId });
        (emitter as any).emit("transcript", {
          segmentId,
          transcript: result.text,
          isFinal: true,
          language: result.language,
          logprobs: result.logprobs,
          avgLogprob: result.avgLogprob,
          isLowConfidence: result.isLowConfidence,
        });
        previousSegmentId = segmentId;
        segmentId = "seg-2";
      },
      clear() {},
      close() {},
      on(event: any, handler: any) {
        emitter.on(event, handler);
        return undefined;
      },
    };
  }
}

class SequencedFakeStt implements SpeechToTextProvider {
  public readonly id = "fake-sequenced";
  constructor(private readonly transcripts: string[]) {}

  createSession(_params: {
    logger: any;
    language?: string;
    prompt?: string;
  }): StreamingTranscriptionSession {
    const emitter = new EventEmitter();
    const transcripts = this.transcripts;
    let segmentId = "seg-1";
    let previousSegmentId: string | null = null;
    let idx = 0;

    return {
      requiredSampleRate: 24000,
      async connect() {},
      appendPcm16() {},
      commit() {
        const transcript = transcripts[idx] ?? "";
        idx += 1;
        (emitter as any).emit("committed", { segmentId, previousSegmentId });
        (emitter as any).emit("transcript", {
          segmentId,
          transcript,
          isFinal: true,
          language: "en",
          isLowConfidence: transcript.length === 0,
        });
        previousSegmentId = segmentId;
        segmentId = `seg-${idx + 1}`;
      },
      clear() {},
      close() {},
      on(event: any, handler: any) {
        emitter.on(event, handler);
        return undefined;
      },
    };
  }
}

describe("STTManager", () => {
  it("returns empty text for low-confidence transcriptions", async () => {
    const manager = new STTManager(
      "s1",
      pino({ level: "silent" }),
      new FakeStt({ text: "um", isLowConfidence: true, avgLogprob: -10 })
    );

    const result = await manager.transcribe(Buffer.alloc(2), "audio/pcm;rate=24000", {
      label: "t",
    });
    expect(result.text).toBe("");
    expect(result.isLowConfidence).toBe(true);
    expect(result.byteLength).toBe(2);
  });

  it("passes through normal transcriptions", async () => {
    const manager = new STTManager(
      "s1",
      pino({ level: "silent" }),
      new FakeStt({ text: "hello world", language: "en", isLowConfidence: false })
    );

    const result = await manager.transcribe(Buffer.alloc(4), "audio/pcm;rate=24000");
    expect(result.text).toBe("hello world");
    expect(result.language).toBe("en");
    expect(result.byteLength).toBe(4);
  });

  it("uses streaming segmentation for batch transcription and concatenates segment finals", async () => {
    const original = process.env.PASEO_STT_BATCH_COMMIT_EVERY_SECONDS;
    process.env.PASEO_STT_BATCH_COMMIT_EVERY_SECONDS = "1";

    try {
      const manager = new STTManager(
        "s1",
        pino({ level: "silent" }),
        new SequencedFakeStt(["alpha", "beta", "gamma"])
      );

      const threeSecondsPcm = Buffer.alloc(24000 * 2 * 3);
      const result = await manager.transcribe(threeSecondsPcm, "audio/pcm;rate=24000");

      expect(result.text).toBe("alpha beta gamma");
      expect(result.language).toBe("en");
      expect(result.byteLength).toBe(threeSecondsPcm.length);
    } finally {
      if (original === undefined) {
        delete process.env.PASEO_STT_BATCH_COMMIT_EVERY_SECONDS;
      } else {
        process.env.PASEO_STT_BATCH_COMMIT_EVERY_SECONDS = original;
      }
    }
  });
});
