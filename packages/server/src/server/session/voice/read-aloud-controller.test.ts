import { describe, expect, it } from "vitest";
import pino from "pino";
import { Readable } from "node:stream";

import { MAX_READ_ALOUD_CHARS, ReadAloudController } from "./read-aloud-controller.js";
import type { SessionOutboundMessage } from "../../messages.js";
import type { TextToSpeechProvider } from "../../speech/speech-provider.js";

type ReadAloudResponse = Extract<
  SessionOutboundMessage,
  { type: "speech.tts.read_aloud.response" }
>;

interface Harness {
  controller: ReadAloudController;
  responses: ReadAloudResponse[];
  synthesized: string[];
}

function createHarness(
  tts: TextToSpeechProvider | null,
  hooks?: {
    onResponse?: (response: ReadAloudResponse, harness: Harness) => void;
  },
): Harness {
  const responses: ReadAloudResponse[] = [];
  const synthesized: string[] = [];

  const wrapped: TextToSpeechProvider | null = tts
    ? {
        async synthesizeSpeech(text: string) {
          synthesized.push(text);
          return tts.synthesizeSpeech(text);
        },
      }
    : null;

  const harness: Harness = {
    controller: new ReadAloudController({
      sessionId: "session-1",
      logger: pino({ level: "silent" }),
      tts: wrapped,
      emit: (message) => {
        if (message.type !== "speech.tts.read_aloud.response") {
          return;
        }
        responses.push(message);
        hooks?.onResponse?.(message, harness);
      },
    }),
    responses,
    synthesized,
  };

  return harness;
}

function fakeTts(audio = "sound"): TextToSpeechProvider {
  return {
    async synthesizeSpeech() {
      return { stream: Readable.from([Buffer.from(audio)]), format: "pcm;rate=24000" };
    },
  };
}

describe("ReadAloudController", () => {
  it("streams one audio segment per sentence, in order, marking only the last", async () => {
    const { controller, responses, synthesized } = createHarness(fakeTts("abc"));

    await controller.handleRequest({
      requestId: "req-1",
      text: "First sentence. Second sentence. Third sentence.",
    });

    expect(synthesized).toEqual(["First sentence.", "Second sentence.", "Third sentence."]);
    expect(responses.map((message) => message.payload.segmentIndex)).toEqual([0, 1, 2]);
    expect(responses.map((message) => message.payload.isLast)).toEqual([false, false, true]);

    for (const message of responses) {
      expect(message.payload.requestId).toBe("req-1");
      expect(message.payload.segmentCount).toBe(3);
      expect(message.payload.format).toBe("pcm;rate=24000");
      expect(message.payload.audio).toBe(Buffer.from("abc").toString("base64"));
      expect(message.payload.error).toBeUndefined();
    }
  });

  it("never sends wrapper markup to the provider", async () => {
    const { controller, synthesized } = createHarness(fakeTts());

    await controller.handleRequest({
      requestId: "req-1",
      text: [
        "<spoken-input>",
        "Are you working?",
        "</spoken-input>",
        "<instruction>This message was spoken by the user.</instruction>",
      ].join("\n"),
    });

    expect(synthesized).toEqual(["Are you working?", "This message was spoken by the user."]);
  });

  it("rejects a selection that is nothing but markup", async () => {
    const { controller, responses, synthesized } = createHarness(fakeTts());

    await controller.handleRequest({ requestId: "req-1", text: "<spoken-input></spoken-input>" });

    expect(synthesized).toEqual([]);
    expect(responses[0].payload.error?.code).toBe("empty_text");
  });

  it("reports tts_unavailable without emitting audio when no provider is configured", async () => {
    const { controller, responses } = createHarness(null);

    await controller.handleRequest({ requestId: "req-1", text: "Read me." });

    expect(responses).toHaveLength(1);
    expect(responses[0].payload.error?.code).toBe("tts_unavailable");
    expect(responses[0].payload.isLast).toBe(true);
    expect(responses[0].payload.audio).toBeUndefined();
  });

  it("rejects text over the length cap instead of synthesizing it", async () => {
    const { controller, responses, synthesized } = createHarness(fakeTts());

    await controller.handleRequest({
      requestId: "req-1",
      text: "word ".repeat(MAX_READ_ALOUD_CHARS),
    });

    expect(synthesized).toEqual([]);
    expect(responses).toHaveLength(1);
    expect(responses[0].payload.error?.code).toBe("text_too_long");
  });

  it("rejects a whitespace-only selection", async () => {
    const { controller, responses, synthesized } = createHarness(fakeTts());

    await controller.handleRequest({ requestId: "req-1", text: "   \n  " });

    expect(synthesized).toEqual([]);
    expect(responses[0].payload.error?.code).toBe("empty_text");
  });

  it("reports synth_failed as a terminal error when the provider throws", async () => {
    const failing: TextToSpeechProvider = {
      async synthesizeSpeech() {
        throw new Error("model not loaded");
      },
    };
    const { controller, responses } = createHarness(failing);

    await controller.handleRequest({ requestId: "req-1", text: "Read me." });

    expect(responses).toHaveLength(1);
    expect(responses[0].payload.error).toEqual({
      code: "synth_failed",
      message: "model not loaded",
    });
    expect(responses[0].payload.isLast).toBe(true);
  });

  it("stops emitting further segments once the client cancels mid-stream", async () => {
    const { controller, responses } = createHarness(fakeTts(), {
      onResponse: (_response, harness) => {
        if (harness.responses.length === 1) {
          harness.controller.cancel("req-1");
        }
      },
    });

    await controller.handleRequest({ requestId: "req-1", text: "One. Two. Three." });

    expect(responses).toHaveLength(1);
    expect(responses[0].payload.segmentIndex).toBe(0);
    expect(responses[0].payload.isLast).toBe(false);
  });

  it("supersedes an in-flight request when a new one arrives", async () => {
    let releaseFirst: (() => void) | null = null;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const slowTts: TextToSpeechProvider = {
      async synthesizeSpeech(text: string) {
        if (text === "Slow.") {
          await firstBlocked;
        }
        return { stream: Readable.from([Buffer.from("x")]), format: "pcm;rate=24000" };
      },
    };

    const { controller, responses } = createHarness(slowTts);

    const first = controller.handleRequest({ requestId: "req-1", text: "Slow." });
    const second = controller.handleRequest({ requestId: "req-2", text: "Fast." });
    releaseFirst?.();
    await Promise.all([first, second]);

    expect(responses.map((message) => message.payload.requestId)).toEqual(["req-2"]);
  });
});
