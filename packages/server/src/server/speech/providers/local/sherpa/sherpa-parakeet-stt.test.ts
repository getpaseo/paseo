import { describe, expect, it } from "vitest";
import pino from "pino";

import { SherpaOnnxParakeetSTT } from "./sherpa-parakeet-stt.js";
import type { SherpaParakeetSttConfig } from "./sherpa-parakeet-stt.js";
import type { TranscriptionResult } from "../../../speech-provider.js";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class TestSherpaOnnxParakeetStt extends SherpaOnnxParakeetSTT {
  public readonly calls: Array<{ audio: Buffer; format: string }> = [];
  public readonly pending: Array<ReturnType<typeof createDeferred<TranscriptionResult>>> = [];

  constructor() {
    super(
      { engine: { sampleRate: 16000 } } as unknown as SherpaParakeetSttConfig,
      pino({ level: "silent" }),
    );
  }

  override async transcribeAudio(
    audioBuffer: Buffer,
    format: string,
  ): Promise<TranscriptionResult> {
    this.calls.push({ audio: Buffer.from(audioBuffer), format });
    const deferred = createDeferred<TranscriptionResult>();
    this.pending.push(deferred);
    return deferred.promise;
  }
}

describe("SherpaOnnxParakeetSTT session", () => {
  it("snapshots segment ids and buffers before async transcription starts", async () => {
    const provider = new TestSherpaOnnxParakeetStt();
    const session = provider.createSession({
      logger: pino({ level: "silent" }),
      language: "en",
    });

    const committed: Array<{ segmentId: string; previousSegmentId: string | null }> = [];
    const transcripts: Array<{ segmentId: string; transcript: string; isFinal: boolean }> = [];

    session.on("committed", (payload) => {
      committed.push(payload);
    });
    session.on("transcript", (payload) => {
      transcripts.push(payload);
    });

    await session.connect();

    session.appendPcm16(Buffer.from([1, 2, 3, 4]));
    session.commit();
    session.appendPcm16(Buffer.from([5, 6, 7, 8]));
    session.commit();

    expect(committed).toHaveLength(2);
    expect(committed[1]?.segmentId).not.toBe(committed[0]?.segmentId);
    expect(committed[0]?.previousSegmentId).toBeNull();
    expect(committed[1]?.previousSegmentId).toBe(committed[0]?.segmentId);

    expect(provider.calls).toEqual([
      { audio: Buffer.from([1, 2, 3, 4]), format: "audio/pcm;rate=16000" },
      { audio: Buffer.from([5, 6, 7, 8]), format: "audio/pcm;rate=16000" },
    ]);

    provider.pending[0]?.resolve({ text: "first", duration: 1 });
    provider.pending[1]?.resolve({ text: "second", duration: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(transcripts).toHaveLength(2);
    expect(transcripts).toEqual([
      expect.objectContaining({
        segmentId: committed[0].segmentId,
        transcript: "first",
        isFinal: true,
      }),
      expect.objectContaining({
        segmentId: committed[1].segmentId,
        transcript: "second",
        isFinal: true,
      }),
    ]);
  });
});
