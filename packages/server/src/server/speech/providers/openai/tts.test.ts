import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

const { openAiConstructorOptionsMock, speechCreateMock } = vi.hoisted(() => ({
  openAiConstructorOptionsMock: vi.fn(),
  speechCreateMock: vi.fn(),
}));

vi.mock("openai", () => ({
  OpenAI: vi.fn(function OpenAI(options: unknown) {
    openAiConstructorOptionsMock(options);
    return {
      audio: {
        speech: {
          create: speechCreateMock,
        },
      },
    };
  }),
}));

import { OpenAITTS } from "./tts.js";

describe("OpenAITTS", () => {
  afterEach(() => {
    openAiConstructorOptionsMock.mockReset();
    speechCreateMock.mockReset();
  });

  test("passes configured baseUrl to the OpenAI client", () => {
    const provider = new OpenAITTS(
      { apiKey: "sk-test", baseUrl: "https://speech.example.com/v1" },
      pino({ level: "silent" }),
    );

    expect(provider.getConfig().baseUrl).toBe("https://speech.example.com/v1");
    expect(openAiConstructorOptionsMock).toHaveBeenCalledWith({
      apiKey: "sk-test",
      baseURL: "https://speech.example.com/v1",
    });
  });

  test("sends custom model, voice, and instructions on instruction-capable models", async () => {
    const { Readable } = await import("node:stream");
    speechCreateMock.mockResolvedValue({ body: Readable.from([Buffer.from("x")]) });
    const provider = new OpenAITTS(
      {
        apiKey: "sk-test",
        model: "gpt-4o-mini-tts",
        voice: "marin",
        instructions: "Speak calmly.",
      },
      pino({ level: "silent" }),
    );

    await provider.synthesizeSpeech("Hello there.");

    expect(speechCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-4o-mini-tts",
        voice: "marin",
        instructions: "Speak calmly.",
      }),
    );
  });

  test("omits instructions for the tts-1 generation, which rejects the parameter", async () => {
    const { Readable } = await import("node:stream");
    speechCreateMock.mockResolvedValue({ body: Readable.from([Buffer.from("x")]) });
    const provider = new OpenAITTS(
      { apiKey: "sk-test", model: "tts-1", instructions: "Speak calmly." },
      pino({ level: "silent" }),
    );

    await provider.synthesizeSpeech("Hello there.");

    const args = speechCreateMock.mock.calls[0][0] as Record<string, unknown>;
    expect(args.model).toBe("tts-1");
    expect("instructions" in args).toBe(false);
  });
});
