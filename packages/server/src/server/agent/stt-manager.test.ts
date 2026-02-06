import { describe, expect, it } from "vitest";
import pino from "pino";

import { STTManager } from "./stt-manager.js";
import type { SpeechToTextProvider, TranscriptionResult } from "../speech/speech-provider.js";

class FakeStt implements SpeechToTextProvider {
  constructor(private readonly result: TranscriptionResult) {}

  async transcribeAudio(): Promise<TranscriptionResult> {
    return this.result;
  }
}

describe("STTManager", () => {
  it("returns empty text for low-confidence transcriptions", async () => {
    const manager = new STTManager(
      "s1",
      pino({ level: "silent" }),
      new FakeStt({ text: "um", isLowConfidence: true, avgLogprob: -10 })
    );

    const result = await manager.transcribe(Buffer.from("x"), "audio/wav", { label: "t" });
    expect(result.text).toBe("");
    expect(result.isLowConfidence).toBe(true);
    expect(result.byteLength).toBe(1);
  });

  it("passes through normal transcriptions", async () => {
    const manager = new STTManager(
      "s1",
      pino({ level: "silent" }),
      new FakeStt({ text: "hello world", language: "en", isLowConfidence: false })
    );

    const result = await manager.transcribe(Buffer.from("abc"), "audio/wav");
    expect(result.text).toBe("hello world");
    expect(result.language).toBe("en");
    expect(result.byteLength).toBe(3);
  });
});

