import { readFile } from "node:fs/promises";
import { ReadStream } from "node:fs";
import pino from "pino";
import { describe, expect, test } from "vitest";
import { OpenAISTT, type TranscriptionClient } from "./stt.js";
import type {
  StreamingTranscriptionEvent,
  StreamingTranscriptionCommittedEvent,
} from "../../speech-provider.js";

const logger = pino({ level: "silent" });

class ControlledTranscriptions implements TranscriptionClient {
  readonly requests: Array<{
    pcm: Buffer;
    request: Parameters<TranscriptionClient["create"]>[0];
    body?: unknown;
    resolve: (response: unknown) => void;
    reject: (error: Error) => void;
  }> = [];

  async create(
    request: Parameters<TranscriptionClient["create"]>[0],
    options?: Parameters<TranscriptionClient["create"]>[1],
  ): Promise<unknown> {
    if (!(request.file instanceof ReadStream) || typeof request.file.path !== "string") {
      throw new Error("Expected the real temporary WAV file");
    }
    const wav = await readFile(request.file.path);
    request.file.destroy();
    return new Promise((resolve, reject) => {
      this.requests.push({ pcm: wav.subarray(44), request, body: options?.body, resolve, reject });
    });
  }
}

function setup(model = "whisper-1") {
  const client = new ControlledTranscriptions();
  const provider = new OpenAISTT({ apiKey: "sk-test", model }, logger, {
    createClient: () => client,
  });
  const session = provider.createSession({ logger, language: "en", prompt: "Paseo, TypeScript" });
  const committed: StreamingTranscriptionCommittedEvent[] = [];
  const transcripts: StreamingTranscriptionEvent[] = [];
  const errors: unknown[] = [];
  session.on("committed", (event) => committed.push(event));
  session.on("transcript", (event) => transcripts.push(event));
  session.on("error", (error) => errors.push(error));
  return { client, session, committed, transcripts, errors };
}

describe("OpenAISTT", () => {
  test("passes configured baseUrl to the client factory", () => {
    let received: unknown;
    const client = new ControlledTranscriptions();
    const provider = new OpenAISTT(
      { apiKey: "sk-test", baseUrl: "https://speech.example.com/v1" },
      logger,
      {
        createClient: (options) => {
          received = options;
          return client;
        },
      },
    );
    expect(provider.id).toBe("openai");
    expect(received).toEqual({ apiKey: "sk-test", baseURL: "https://speech.example.com/v1" });
  });

  test.each(["before", "after"])(
    "keeps the final chunk when stop is %s the previous response",
    async (stop) => {
      const { client, session, committed, transcripts, errors } = setup();
      await session.connect();
      session.appendPcm16(Buffer.from([1, 0, 2, 0]));
      session.commit();
      await expect.poll(() => client.requests.length).toBe(1);
      session.appendPcm16(Buffer.from([3, 0, 4, 0]));
      if (stop === "after") {
        client.requests[0]!.resolve({ text: "first" });
        await expect.poll(() => transcripts.length).toBe(1);
      }
      session.commit();
      await expect.poll(() => client.requests.length).toBe(2);
      expect(client.requests.map((request) => [...request.pcm])).toEqual([
        [1, 0, 2, 0],
        [3, 0, 4, 0],
      ]);
      expect(new Set(committed.map((event) => event.segmentId)).size).toBe(2);
      expect(committed[1]!.previousSegmentId).toBe(committed[0]!.segmentId);
      client.requests[1]!.resolve({ text: "last" });
      if (stop === "before") client.requests[0]!.resolve({ text: "first" });
      await expect.poll(() => transcripts.length).toBe(2);
      expect(
        transcripts.find((event) => event.segmentId === committed[1]!.segmentId)?.transcript,
      ).toBe("last");
      expect(errors).toEqual([]);
      session.close();
    },
  );

  test("keeps three overlapping commits distinct when responses finish in reverse order", async () => {
    const { client, session, committed, transcripts } = setup();
    await session.connect();
    for (const sample of [1, 2, 3]) {
      session.appendPcm16(Buffer.from([sample, 0]));
      session.commit();
      await expect.poll(() => client.requests.length).toBe(sample);
    }
    await expect.poll(() => client.requests.length).toBe(3);
    expect(client.requests.map((request) => [...request.pcm])).toEqual([
      [1, 0],
      [2, 0],
      [3, 0],
    ]);
    expect(new Set(committed.map((event) => event.segmentId)).size).toBe(3);
    expect(committed.map((event) => event.previousSegmentId)).toEqual([
      null,
      committed[0]!.segmentId,
      committed[1]!.segmentId,
    ]);
    for (const request of client.requests.toReversed())
      request.resolve({ text: String(request.pcm[0]) });
    await expect.poll(() => transcripts.length).toBe(3);
    const bySegment = new Map(transcripts.map((event) => [event.segmentId, event.transcript]));
    expect(committed.map((event) => bySegment.get(event.segmentId))).toEqual(["1", "2", "3"]);
    session.close();
  });

  test("preserves the next segment after a transcription error", async () => {
    const { client, session, transcripts, errors } = setup();
    await session.connect();
    session.appendPcm16(Buffer.from([1, 0]));
    session.commit();
    await expect.poll(() => client.requests.length).toBe(1);
    session.appendPcm16(Buffer.from([2, 0]));
    client.requests[0]!.reject(new Error("request failed"));
    await expect.poll(() => errors.length).toBe(1);
    session.commit();
    await expect.poll(() => client.requests.length).toBe(2);
    expect([...client.requests[1]!.pcm]).toEqual([2, 0]);
    client.requests[1]!.resolve({ text: "last" });
    await expect.poll(() => transcripts.length).toBe(1);
    session.close();
  });

  test("does not upload an empty commit", async () => {
    const { client, session, transcripts } = setup();
    await session.connect();
    session.commit();
    expect(transcripts[0]?.transcript).toBe("");
    expect(client.requests).toEqual([]);
    session.close();
  });

  test("preserves explicit context and confidence metadata for gpt-4o-transcribe", async () => {
    const { client, session, transcripts } = setup("gpt-4o-transcribe");
    await session.connect();
    session.appendPcm16(Buffer.from([1, 0]));
    session.commit();
    await expect.poll(() => client.requests.length).toBe(1);
    expect(client.requests[0]!.request).toMatchObject({
      language: "en",
      model: "gpt-4o-transcribe",
      prompt: "Paseo, TypeScript",
      include: ["logprobs"],
      response_format: "json",
    });
    client.requests[0]!.resolve({
      text: "Paseo",
      logprobs: [{ token: "Paseo", logprob: -0.5, bytes: [80] }],
    });
    await expect.poll(() => transcripts.length).toBe(1);
    expect(transcripts[0]).toMatchObject({
      transcript: "Paseo",
      avgLogprob: -0.5,
      isLowConfidence: false,
    });
    session.close();
  });

  test("uses plural language hints for gpt-transcribe", async () => {
    const { client, session, transcripts } = setup("gpt-transcribe");
    await session.connect();
    session.appendPcm16(Buffer.from([1, 0]));
    session.commit();
    await expect.poll(() => client.requests.length).toBe(1);
    expect(client.requests[0]!.request).not.toHaveProperty("language");
    expect(client.requests[0]!.body).toMatchObject({
      model: "gpt-transcribe",
      languages: ["en"],
      prompt: "Paseo, TypeScript",
      response_format: "json",
    });
    client.requests[0]!.resolve({ text: "hello", languages: [{ code: "en" }] });
    await expect.poll(() => transcripts.length).toBe(1);
    expect(transcripts[0]?.language).toBe("en");
    session.close();
  });
});
