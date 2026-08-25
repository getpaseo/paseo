import pino from "pino";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";

const { openAiConstructorOptionsMock, transcriptionsCreateMock } = vi.hoisted(() => ({
  openAiConstructorOptionsMock: vi.fn(),
  transcriptionsCreateMock: vi.fn(),
}));

vi.mock("openai", () => ({
  OpenAI: vi.fn(function OpenAI(options: unknown) {
    openAiConstructorOptionsMock(options);
    return {
      audio: {
        transcriptions: {
          create: transcriptionsCreateMock,
        },
      },
    };
  }),
}));

import { OpenAISTT } from "./stt.js";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function drainStream(stream: NodeJS.ReadableStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.once("error", reject);
    stream.once("end", resolve);
    stream.resume();
  });
}

describe("OpenAISTT", () => {
  afterEach(() => {
    openAiConstructorOptionsMock.mockReset();
    transcriptionsCreateMock.mockReset();
  });

  test("passes configured baseUrl to the OpenAI client", () => {
    const provider = new OpenAISTT(
      { apiKey: "sk-test", baseUrl: "https://speech.example.com/v1" },
      pino({ level: "silent" }),
    );

    expect(provider.id).toBe("openai");
    expect(openAiConstructorOptionsMock).toHaveBeenCalledWith({
      apiKey: "sk-test",
      baseURL: "https://speech.example.com/v1",
    });
  });

  test("passes transcription prompt to OpenAI REST STT", async () => {
    transcriptionsCreateMock.mockImplementation(
      async (request: { file: NodeJS.ReadableStream }) => {
        await drainStream(request.file);
        return { text: "hello" };
      },
    );

    const provider = new OpenAISTT(
      { apiKey: "sk-test", model: "gpt-4o-transcribe" },
      pino({ level: "silent" }),
    );
    const session = provider.createSession({
      logger: pino({ level: "silent" }),
      language: "en",
      prompt: "Only transcribe the speaker.",
    });

    const transcript = new Promise<string>((resolve, reject) => {
      session.on("transcript", (event) => {
        if (event.isFinal) {
          resolve(event.transcript);
        }
      });
      session.on("error", (error) => {
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });

    await session.connect();
    session.appendPcm16(Buffer.from([0, 0, 0, 0]));
    session.commit();

    await expect(transcript).resolves.toBe("hello");
    expect(transcriptionsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        language: "en",
        model: "gpt-4o-transcribe",
        prompt: "Only transcribe the speaker.",
        response_format: "json",
      }),
    );
  });

  test("keeps audio appended while an OpenAI transcription is in flight", async () => {
    const firstTranscription = createDeferred<{ text: string }>();
    const transcripts: string[] = [];

    transcriptionsCreateMock.mockImplementation(async (request: { file: Readable }) => {
      await drainStream(request.file);
      if (transcriptionsCreateMock.mock.calls.length === 1) {
        await firstTranscription.promise;
        return { text: "first" };
      }
      return { text: "second" };
    });

    const provider = new OpenAISTT({ apiKey: "sk-test" }, pino({ level: "silent" }));
    const session = provider.createSession({
      logger: pino({ level: "silent" }),
      language: "en",
    });

    session.on("transcript", (event) => {
      if (event.isFinal) {
        transcripts.push(event.transcript);
      }
    });

    await session.connect();
    session.appendPcm16(Buffer.from([1, 0, 1, 0]));
    session.commit();

    await vi.waitFor(() => {
      expect(transcriptionsCreateMock).toHaveBeenCalledTimes(1);
    });

    session.appendPcm16(Buffer.from([2, 0, 2, 0]));
    firstTranscription.resolve({ text: "first" });

    await vi.waitFor(() => {
      expect(transcripts).toEqual(["first"]);
    });

    session.commit();

    await vi.waitFor(() => {
      expect(transcripts).toEqual(["first", "second"]);
    });
    expect(transcriptionsCreateMock).toHaveBeenCalledTimes(2);
  });
});
