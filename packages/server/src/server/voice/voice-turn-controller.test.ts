import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import pino from "pino";

import type {
  TurnDetectionProvider,
  TurnDetectionSession,
} from "../speech/turn-detection-provider.js";
import { createVoiceTurnController, type DetectedVoiceUtterance } from "./voice-turn-controller.js";

class FakeTurnDetectionSession extends EventEmitter implements TurnDetectionSession {
  public readonly requiredSampleRate = 16000;
  public readonly appendedChunks: Buffer[] = [];

  async connect(): Promise<void> {}

  appendPcm16(chunk: Buffer): void {
    this.appendedChunks.push(chunk);
  }

  flush(): void {}
  reset(): void {}
  close(): void {}
}

function createFakeTurnDetectionProvider(session: FakeTurnDetectionSession): TurnDetectionProvider {
  return {
    id: "local",
    createSession() {
      return session;
    },
  };
}

async function settleSerialQueue(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createControllerHarness() {
  const detector = new FakeTurnDetectionSession();
  const onSpeechStarted = vi.fn(async () => {});
  const onSpeechStopped = vi.fn(async () => {});
  const submitUtterance = vi.fn(async (_utterance: DetectedVoiceUtterance) => {});
  const onError = vi.fn();

  const controller = createVoiceTurnController({
    logger: pino({ level: "silent" }),
    turnDetection: createFakeTurnDetectionProvider(detector),
    prefixDurationMs: 100,
    utteranceSink: {
      submitUtterance,
    },
    callbacks: {
      onSpeechStarted,
      onSpeechStopped,
      onError,
    },
  });

  return {
    controller,
    detector,
    onSpeechStarted,
    onSpeechStopped,
    submitUtterance,
    onError,
  };
}

function createDeferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("voice turn controller", () => {
  it("buffers audio before speech start and includes the prefix in the utterance", async () => {
    const harness = createControllerHarness();

    await harness.controller.start();
    await harness.controller.appendClientChunk({
      audioBase64: Buffer.from([1, 2, 3, 4]).toString("base64"),
      format: "audio/pcm;rate=16000;bits=16",
    });
    await harness.controller.appendClientChunk({
      audioBase64: Buffer.from([5, 6, 7, 8]).toString("base64"),
      format: "audio/pcm;rate=16000;bits=16",
    });

    harness.detector.emit("speech_started");
    await settleSerialQueue();

    await harness.controller.appendClientChunk({
      audioBase64: Buffer.from([9, 10, 11, 12]).toString("base64"),
      format: "audio/pcm;rate=16000;bits=16",
    });

    harness.detector.emit("speech_stopped");
    await settleSerialQueue();

    expect(harness.onSpeechStarted).toHaveBeenCalledTimes(1);
    expect(harness.onSpeechStopped).toHaveBeenCalledTimes(1);
    expect(harness.submitUtterance).toHaveBeenCalledTimes(1);
    expect(harness.submitUtterance).toHaveBeenCalledWith(
      expect.objectContaining({
        pcm16: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
        sampleRate: 16000,
        format: "audio/pcm;rate=16000;bits=16",
      }),
    );
    expect(harness.onError).not.toHaveBeenCalled();
  });

  it("finalizes one utterance when speech stops", async () => {
    const harness = createControllerHarness();

    await harness.controller.start();
    await harness.controller.appendClientChunk({
      audioBase64: Buffer.from([1, 1, 1, 1]).toString("base64"),
      format: "audio/pcm;rate=16000;bits=16",
    });

    harness.detector.emit("speech_started");
    await settleSerialQueue();

    await harness.controller.appendClientChunk({
      audioBase64: Buffer.from([2, 2, 2, 2]).toString("base64"),
      format: "audio/pcm;rate=16000;bits=16",
    });

    harness.detector.emit("speech_stopped");
    await settleSerialQueue();
    harness.detector.emit("speech_stopped");
    await settleSerialQueue();

    expect(harness.submitUtterance).toHaveBeenCalledTimes(1);
    expect(harness.onSpeechStopped).toHaveBeenCalledTimes(1);
    expect(harness.onError).not.toHaveBeenCalled();
  });

  it("does not barge in or emit an utterance on silence-only chunks", async () => {
    const harness = createControllerHarness();

    await harness.controller.start();
    await harness.controller.appendClientChunk({
      audioBase64: Buffer.from([0, 0, 0, 0]).toString("base64"),
      format: "audio/pcm;rate=16000;bits=16",
    });
    await harness.controller.appendClientChunk({
      audioBase64: Buffer.from([0, 0, 0, 0]).toString("base64"),
      format: "audio/pcm;rate=16000;bits=16",
    });
    await settleSerialQueue();

    expect(harness.detector.appendedChunks).toEqual([
      Buffer.from([0, 0, 0, 0]),
      Buffer.from([0, 0, 0, 0]),
    ]);
    expect(harness.onSpeechStarted).not.toHaveBeenCalled();
    expect(harness.onSpeechStopped).not.toHaveBeenCalled();
    expect(harness.submitUtterance).not.toHaveBeenCalled();
    expect(harness.onError).not.toHaveBeenCalled();
  });

  it("retains a rolling prefix for rapid follow-up utterances", async () => {
    const harness = createControllerHarness();

    await harness.controller.start();
    await harness.controller.appendClientChunk({
      audioBase64: Buffer.from([1, 2, 3, 4]).toString("base64"),
      format: "audio/pcm;rate=16000;bits=16",
    });

    harness.detector.emit("speech_started");
    await settleSerialQueue();

    await harness.controller.appendClientChunk({
      audioBase64: Buffer.from([5, 6, 7, 8]).toString("base64"),
      format: "audio/pcm;rate=16000;bits=16",
    });

    harness.detector.emit("speech_stopped");
    await settleSerialQueue();

    await harness.controller.appendClientChunk({
      audioBase64: Buffer.from([9, 10, 11, 12]).toString("base64"),
      format: "audio/pcm;rate=16000;bits=16",
    });

    harness.detector.emit("speech_started");
    await settleSerialQueue();

    await harness.controller.appendClientChunk({
      audioBase64: Buffer.from([13, 14, 15, 16]).toString("base64"),
      format: "audio/pcm;rate=16000;bits=16",
    });

    harness.detector.emit("speech_stopped");
    await settleSerialQueue();

    expect(harness.submitUtterance).toHaveBeenCalledTimes(2);
    expect(harness.onSpeechStopped).toHaveBeenCalledTimes(2);
    expect(harness.submitUtterance.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        pcm16: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
      }),
    );
    expect(harness.submitUtterance.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        pcm16: Buffer.from([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
      }),
    );
  });

  it("continues detecting speech while a previous utterance submission is still pending", async () => {
    const deferred = createDeferredPromise<void>();
    const detector = new FakeTurnDetectionSession();
    const onSpeechStarted = vi.fn(async () => {});
    const onSpeechStopped = vi.fn(async () => {});
    const submitUtterance = vi.fn(async () => {
      await deferred.promise;
    });
    const onError = vi.fn();

    const controller = createVoiceTurnController({
      logger: pino({ level: "silent" }),
      turnDetection: createFakeTurnDetectionProvider(detector),
      prefixDurationMs: 100,
      utteranceSink: {
        submitUtterance,
      },
      callbacks: {
        onSpeechStarted,
        onSpeechStopped,
        onError,
      },
    });

    await controller.start();
    await controller.appendClientChunk({
      audioBase64: Buffer.from([1, 2, 3, 4]).toString("base64"),
      format: "audio/pcm;rate=16000;bits=16",
    });
    detector.emit("speech_started");
    await settleSerialQueue();
    await controller.appendClientChunk({
      audioBase64: Buffer.from([5, 6, 7, 8]).toString("base64"),
      format: "audio/pcm;rate=16000;bits=16",
    });
    detector.emit("speech_stopped");
    await settleSerialQueue();

    await controller.appendClientChunk({
      audioBase64: Buffer.from([9, 10, 11, 12]).toString("base64"),
      format: "audio/pcm;rate=16000;bits=16",
    });
    detector.emit("speech_started");
    await settleSerialQueue();

    expect(onSpeechStarted).toHaveBeenCalledTimes(2);
    expect(onSpeechStopped).toHaveBeenCalledTimes(1);
    expect(submitUtterance).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();

    deferred.resolve();
    await settleSerialQueue();
  });
});
