import { describe, expect, it } from "vitest";

import { SherpaParakeetRealtimeTranscriptionSession } from "./sherpa-parakeet-realtime-session.js";
import type { SherpaOfflineRecognizerEngine } from "./sherpa-offline-recognizer.js";

function pcm16(value: number): Buffer {
  const samples = new Int16Array([value]);
  return Buffer.from(samples.buffer);
}

function createEngine(): SherpaOfflineRecognizerEngine {
  return {
    sampleRate: 16000,
    createStream() {
      return {
        samples: new Float32Array(0),
        acceptWaveform(input: { samples: Float32Array }) {
          this.samples = input.samples;
        },
        free() {
          // no-op
        },
      };
    },
    acceptWaveform(stream: { samples: Float32Array }, _sampleRate: number, samples: Float32Array) {
      stream.samples = samples;
    },
    recognizer: {
      decode() {
        // no-op
      },
      getResult(stream: { samples: Float32Array }) {
        const firstSample = Math.abs(stream.samples[0] ?? 0);
        return { text: firstSample > 0.4 ? "second" : "first" };
      },
    },
  } as unknown as SherpaOfflineRecognizerEngine;
}

describe("SherpaParakeetRealtimeTranscriptionSession", () => {
  it("keeps audio appended after commit for the next segment", async () => {
    const session = new SherpaParakeetRealtimeTranscriptionSession({
      engine: createEngine(),
      minDecodeIntervalMs: Number.MAX_SAFE_INTEGER,
    });
    const transcripts: string[] = [];

    session.on("transcript", (event) => {
      if (event.isFinal) {
        transcripts.push(event.transcript);
      }
    });

    await session.connect();
    session.appendPcm16(pcm16(0));
    session.commit();
    session.appendPcm16(pcm16(24000));

    await new Promise((resolve) => setTimeout(resolve, 0));

    session.commit();

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(transcripts).toEqual(["first", "second"]);
  });
});
