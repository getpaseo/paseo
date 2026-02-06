import { describe, expect, it } from "vitest";
import pino from "pino";
import { Readable } from "node:stream";

import { TTSManager } from "./tts-manager.js";
import type { TextToSpeechProvider } from "../speech/speech-provider.js";
import type { SessionOutboundMessage } from "../messages.js";

class FakeTts implements TextToSpeechProvider {
  async synthesizeSpeech(): Promise<{ stream: Readable; format: string }> {
    return {
      stream: Readable.from([Buffer.from("a"), Buffer.from("b")]),
      format: "pcm;rate=24000",
    };
  }
}

describe("TTSManager", () => {
  it("emits chunks and resolves once confirmed", async () => {
    const manager = new TTSManager("s1", pino({ level: "silent" }), new FakeTts());
    const abort = new AbortController();
    const emitted: SessionOutboundMessage[] = [];

    const task = manager.generateAndWaitForPlayback(
      "hello",
      (msg) => {
        emitted.push(msg);
        if (msg.type === "audio_output") {
          manager.confirmAudioPlayed(msg.payload.id);
        }
      },
      abort.signal,
      true
    );

    await task;

    const audioMsgs = emitted.filter((m) => m.type === "audio_output");
    expect(audioMsgs).toHaveLength(2);
    const groupId = (audioMsgs[0] as any).payload.groupId;
    expect(groupId).toBeTruthy();
    expect((audioMsgs[0] as any).payload.chunkIndex).toBe(0);
    expect((audioMsgs[1] as any).payload.chunkIndex).toBe(1);
    expect((audioMsgs[1] as any).payload.isLastChunk).toBe(true);
  });
});

