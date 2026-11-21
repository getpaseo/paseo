import pino from "pino";
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

function drainByteCount(stream: NodeJS.ReadableStream): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let bytes = 0;
    stream.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
    });
    stream.once("error", reject);
    stream.once("end", () => resolve(bytes));
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
        await new Promise<void>((resolve, reject) => {
          request.file.once("error", reject);
          request.file.once("end", resolve);
          request.file.resume();
        });
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
  test("audio that arrives while a segment is being transcribed goes to the next segment", async () => {
    const uploadedBytes: number[] = [];
    const releaseUploads: Array<() => void> = [];
    transcriptionsCreateMock.mockImplementation(
      async (request: { file: NodeJS.ReadableStream }) => {
        const bytes = await drainByteCount(request.file);
        uploadedBytes.push(bytes);
        await new Promise<void>((resolve) => releaseUploads.push(resolve));
        return { text: `segment of ${bytes} bytes` };
      },
    );
    const provider = new OpenAISTT({ apiKey: "sk-test" }, pino({ level: "silent" }));
    const session = provider.createSession({ logger: pino({ level: "silent" }) });
    const finals: Array<{ segmentId: string; transcript: string }> = [];
    session.on("transcript", (event) => {
      finals.push({ segmentId: event.segmentId, transcript: event.transcript });
    });

    const wavHeaderBytes = 44;
    await session.connect();
    session.appendPcm16(Buffer.alloc(1000));
    session.commit();
    await vi.waitFor(() => expect(releaseUploads).toHaveLength(1));

    // The user keeps talking while the first segment is still with the provider.
    session.appendPcm16(Buffer.alloc(600));
    session.commit();
    await vi.waitFor(() => expect(releaseUploads).toHaveLength(2));
    releaseUploads.forEach((release) => release());
    await vi.waitFor(() => expect(finals).toHaveLength(2));

    expect(uploadedBytes).toEqual([wavHeaderBytes + 1000, wavHeaderBytes + 600]);
    expect(new Set(finals.map((final) => final.segmentId)).size).toBe(2);
  });
});
