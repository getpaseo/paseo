import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import { Readable } from "node:stream";

import { TTSManager } from "./tts-manager.js";
import type { TextToSpeechProvider } from "../speech/speech-provider.js";
import type { SessionOutboundMessage } from "../messages.js";

type AudioOutputMessage = Extract<SessionOutboundMessage, { type: "audio_output" }>;

function isAudioOutputMessage(message: SessionOutboundMessage): message is AudioOutputMessage {
  return message.type === "audio_output";
}

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
      true,
    );

    await task;

    const audioMsgs = emitted.filter((m) => m.type === "audio_output");
    expect(audioMsgs).toHaveLength(1);
    const [audioMessage] = emitted.filter(isAudioOutputMessage);
    expect(audioMessage).toBeDefined();
    expect(audioMessage?.payload.groupId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(audioMessage?.payload.chunkIndex).toBe(0);
    expect(audioMessage?.payload.isLastChunk).toBe(true);
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
      true,
    );

    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((text) => text.length <= 260)).toBe(true);
    expect(calls[0]!.length).toBeLessThanOrEqual(120);
    expect(calls.slice(1).some((text) => text.length > calls[0]!.length)).toBe(true);
  });

  it("prefetches the next segment before current playback completes", async () => {
    const started: string[] = [];
    const gateResolvers = new Map<string, () => void>();
    const tts: TextToSpeechProvider = {
      async synthesizeSpeech(text: string): Promise<{ stream: Readable; format: string }> {
        started.push(text);
        await new Promise<void>((resolve) => {
          gateResolvers.set(text, resolve);
        });
        return {
          stream: Readable.from([Buffer.from(text)]),
          format: "pcm;rate=24000",
        };
      },
    };

    const manager = new TTSManager("s1", pino({ level: "silent" }), tts);
    const abort = new AbortController();
    const segments = [
      "One sentence that is long enough to stand alone in the first voice chunk.",
      "Two sentence that is also long enough to require a separate synthesized group.",
      "Three sentence that should only be synthesized after playback of the first group starts because it carries extra detail about the lookahead pipeline and should exceed the later packing target on its own.",
    ];
    const text = segments.join(" ");
    const emittedGroups: string[] = [];
    let firstChunkId: string | null = null;
    let releaseSecondAck: (() => void) | null = null;

    const task = manager.generateAndWaitForPlayback(
      text,
      (msg) => {
        if (msg.type !== "audio_output") {
          return;
        }

        if (!emittedGroups.includes(msg.payload.groupId!)) {
          emittedGroups.push(msg.payload.groupId!);
        }

        if (emittedGroups.length === 1) {
          firstChunkId = msg.payload.id;
          return;
        }

        releaseSecondAck?.();
        manager.confirmAudioPlayed(msg.payload.id);
      },
      abort.signal,
      true,
    );

    expect(started).toEqual([segments[0], segments[1]]);

    gateResolvers.get(segments[0])?.();
    await vi.waitFor(() => {
      expect(firstChunkId).not.toBeNull();
    });

    expect(started).toEqual(segments);
    expect(emittedGroups).toHaveLength(1);

    const secondGroupPlayed = new Promise<void>((resolve) => {
      releaseSecondAck = resolve;
    });

    manager.confirmAudioPlayed(firstChunkId!);
    gateResolvers.get(segments[1])?.();

    await vi.waitFor(() => {
      expect(started).toEqual(segments);
      expect(emittedGroups).toHaveLength(2);
    });

    gateResolvers.get(segments[2])?.();
    await secondGroupPlayed;
    await task;
  });

  it("destroys prefetched streams after abort", async () => {
    const destroyed: string[] = [];
    const tts: TextToSpeechProvider = {
      async synthesizeSpeech(text: string): Promise<{ stream: Readable; format: string }> {
        const stream = new Readable({
          read() {
            this.push(Buffer.from(text));
            this.push(null);
          },
        });
        const destroySpy = vi.spyOn(stream, "destroy").mockImplementation(function (
          this: Readable,
          error?: Error,
        ) {
          destroyed.push(text);
          return Readable.prototype.destroy.call(this, error);
        });
        void destroySpy;
        return {
          stream,
          format: "pcm;rate=24000",
        };
      },
    };

    const manager = new TTSManager("s1", pino({ level: "silent" }), tts);
    const abort = new AbortController();
    let firstChunkId: string | null = null;

    const task = manager.generateAndWaitForPlayback(
      [
        "First sentence that is long enough to stand alone in the first synthesized group.",
        "Second sentence that should be prefetched and then discarded after abort is requested.",
        "Third sentence that should also be cleaned up if it was prefetched before the abort.",
      ].join(" "),
      (msg) => {
        if (msg.type === "audio_output" && firstChunkId === null) {
          firstChunkId = msg.payload.id;
        }
      },
      abort.signal,
      true,
    );

    await vi.waitFor(() => {
      expect(firstChunkId).not.toBeNull();
    });

    abort.abort();

    await task;
    await vi.waitFor(() => {
      expect(destroyed.length).toBeGreaterThanOrEqual(2);
    });
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
            })(),
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
          true,
        ),
      ).rejects.toThrow("stream exploded");

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("ignores late confirmations for recently closed audio IDs", async () => {
    const logger = pino({ level: "silent" });
    const warnSpy = vi.spyOn(logger, "warn");
    const manager = new TTSManager("s1", logger, new FakeTts());
    const abort = new AbortController();
    const emitted: SessionOutboundMessage[] = [];

    await manager.generateAndWaitForPlayback(
      "hello",
      (msg) => {
        emitted.push(msg);
        if (msg.type === "audio_output") {
          manager.confirmAudioPlayed(msg.payload.id);
        }
      },
      abort.signal,
      true,
    );

    const firstAudio = emitted.find((msg) => msg.type === "audio_output");
    expect(firstAudio?.type).toBe("audio_output");

    manager.confirmAudioPlayed(
      (firstAudio as Extract<SessionOutboundMessage, { type: "audio_output" }>).payload.id,
    );

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
