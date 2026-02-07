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

  it("splits long text into safe synthesis segments", async () => {
    const calls: string[] = [];
    const tts: TextToSpeechProvider = {
      async synthesizeSpeech(text: string): Promise<{ stream: Readable; format: string }> {
        calls.push(text);
        return {
          stream: Readable.from([Buffer.from("x")]),
          format: "pcm;rate=24000",
        };
      },
    };

    const manager = new TTSManager("s1", pino({ level: "silent" }), tts);
    const abort = new AbortController();
    const longText = Array.from({ length: 180 })
      .map((_, i) => `Sentence ${i + 1}.`)
      .join(" ");

    await manager.generateAndWaitForPlayback(
      longText,
      (msg) => {
        if (msg.type === "audio_output") {
          manager.confirmAudioPlayed(msg.payload.id);
        }
      },
      abort.signal,
      true
    );

    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((text) => text.length <= 400)).toBe(true);
  });

  it("does not emit unhandled rejections when stream iteration fails", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const tts: TextToSpeechProvider = {
        async synthesizeSpeech(): Promise<{ stream: Readable; format: string }> {
          const stream = Readable.from(
            (async function* () {
              yield Buffer.from("a");
              throw new Error("stream exploded");
            })()
          );
          return {
            stream,
            format: "pcm;rate=24000",
          };
        },
      };

      const manager = new TTSManager("s1", pino({ level: "silent" }), tts);
      const abort = new AbortController();

      await expect(
        manager.generateAndWaitForPlayback(
          "hello",
          (msg) => {
            if (msg.type === "audio_output") {
              manager.confirmAudioPlayed(msg.payload.id);
            }
          },
          abort.signal,
          true
        )
      ).rejects.toThrow("stream exploded");

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
