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

  test("logs the resolved baseUrl and never the api key", () => {
    const records: Array<Record<string, unknown>> = [];
    const logger = pino(
      { level: "info" },
      {
        write: (chunk: string) => {
          records.push(JSON.parse(chunk) as Record<string, unknown>);
        },
      },
    );

    const provider = new OpenAITTS(
      { apiKey: "sk-secret", baseUrl: "https://speech.example.com/v1" },
      logger,
    );
    expect(provider.getConfig().baseUrl).toBe("https://speech.example.com/v1");

    const init = records.find((entry) => entry.msg === "TTS (OpenAI) initialized");
    expect(init?.baseUrl).toBe("https://speech.example.com/v1");
    expect(JSON.stringify(init)).not.toContain("sk-secret");
  });
});
