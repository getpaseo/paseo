import pino from "pino";
import { describe, expect, test } from "vitest";
import { OpenAISTT } from "./stt.js";
import type { StreamingTranscriptionSession } from "../../speech-provider.js";

const logger = pino({ level: "silent" });
function transcript(session: StreamingTranscriptionSession): Promise<string> {
  return new Promise((resolve, reject) => {
    session.on("transcript", (event) => {
      resolve(event.transcript);
    });
    session.on("error", reject);
  });
}

describe("OpenAISTT", () => {
  test("clearing an uncommitted tail preserves pending transcripts and the next recording", async () => {
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const uploads: Request[] = [];
    const provider = new OpenAISTT(
      { auth: "none", baseUrl: "http://127.0.0.1:18081/v1" },
      logger,
      async (url, init) => {
        if (String(url) === "data:,") return new Response();
        uploads.push(new Request(url, init));
        if (uploads.length === 1) {
          started();
          return firstResponse;
        }
        return Response.json({ text: "second" });
      },
    );
    const session = provider.createSession({ logger });
    const firstTranscript = transcript(session);
    await session.connect();
    session.appendPcm16(Buffer.from([0, 1]));
    session.commit();
    await firstStarted;
    session.appendPcm16(Buffer.from([4, 5]));
    session.clear();
    session.appendPcm16(Buffer.from([2, 3]));
    finish(Response.json({ text: "first" }));
    expect(await firstTranscript).toBe("first");
    const secondTranscript = transcript(session);
    session.commit();
    expect(await secondTranscript).toBe("second");
    session.close();
    expect(uploads).toHaveLength(2);
    const form = await uploads[1].formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new Error("Expected audio upload");
    expect(Buffer.from(await file.arrayBuffer()).subarray(44)).toEqual(Buffer.from([2, 3]));
  });
  test("sends the existing OpenAI model, prompt, language and logprobs request", async () => {
    const requests: Request[] = [];
    const provider = new OpenAISTT(
      { apiKey: "test-key", baseUrl: "https://speech.example/v1", model: "gpt-4o-transcribe" },
      logger,
      async (url, init) => {
        if (String(url) === "data:,") return new Response();
        requests.push(new Request(url, init));
        return Response.json({ text: "hello" });
      },
    );
    const session = provider.createSession({
      logger,
      language: "en",
      prompt: "Only transcribe the speaker.",
    });
    const result = transcript(session);
    await session.connect();
    session.appendPcm16(Buffer.from([0, 0, 0, 0]));
    session.commit();
    expect(await result).toBe("hello");
    session.close();
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://speech.example/v1/audio/transcriptions");
    expect(requests[0].headers.get("authorization")).toBe("Bearer test-key");
    const form = await requests[0].formData();
    expect(form.get("model")).toBe("gpt-4o-transcribe");
    expect(form.get("language")).toBe("en");
    expect(form.get("prompt")).toBe("Only transcribe the speaker.");
    expect(form.get("response_format")).toBe("json");
    expect(form.getAll("include[]")).toEqual(["logprobs"]);
  });

  test("uploads mono 24kHz PCM16 WAV with custom model and no authentication", async () => {
    const requests: Request[] = [];
    const provider = new OpenAISTT(
      { auth: "none", baseUrl: "http://127.0.0.1:18081/v1", model: "Example/ASR-8bit" },
      logger,
      async (url, init) => {
        if (String(url) === "data:,") return new Response();
        requests.push(new Request(url, init));
        return Response.json({ text: "你好，世界。" });
      },
    );
    const session = provider.createSession({ logger, language: "zh" });
    const result = transcript(session);
    await session.connect();
    const pcm = Buffer.from([0, 1, 2, 3]);
    session.appendPcm16(pcm);
    session.commit();
    expect(await result).toBe("你好，世界。");
    session.close();
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("http://127.0.0.1:18081/v1/audio/transcriptions");
    expect(requests[0].headers.get("authorization")).toBeNull();
    const form = await requests[0].formData();
    expect(form.get("model")).toBe("Example/ASR-8bit");
    expect(form.get("language")).toBe("zh");
    expect(form.get("response_format")).toBe("json");
    expect(form.get("include[]")).toBeNull();
    const file = form.get("file");
    if (!(file instanceof File)) throw new Error("Expected audio upload");
    const wav = Buffer.from(await file.arrayBuffer());
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(24000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.subarray(44)).toEqual(pcm);
  });

  test("close aborts pending transcription", async () => {
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let aborted!: () => void;
    const requestAborted = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    const provider = new OpenAISTT(
      { auth: "none", baseUrl: "http://127.0.0.1:18081/v1" },
      logger,
      async (url, init) => {
        if (String(url) === "data:,") return new Response();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              aborted();
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
          started();
        });
      },
    );
    const session = provider.createSession({ logger });
    const events: unknown[] = [];
    session.on("transcript", (event) => {
      events.push(event);
    });
    session.on("error", (error) => {
      events.push(error);
    });
    await session.connect();
    session.appendPcm16(Buffer.from([0, 0]));
    session.commit();
    await requestStarted;
    session.close();
    await requestAborted;
    expect(events).toEqual([]);
    session.close();
  });

  test("reports local transcription failure without cloud fallback", async () => {
    const urls: string[] = [];
    const provider = new OpenAISTT(
      { auth: "none", baseUrl: "http://127.0.0.1:18081/v1" },
      logger,
      async (url) => {
        if (String(url) === "data:,") return new Response();
        urls.push(String(url));
        return new Response("unavailable", { status: 503 });
      },
    );
    const session = provider.createSession({ logger });
    const failed = expect(transcript(session)).rejects.toThrow("503");
    await session.connect();
    session.appendPcm16(Buffer.from([0, 0]));
    session.commit();
    await failed;
    session.close();
    expect(urls).toEqual(["http://127.0.0.1:18081/v1/audio/transcriptions"]);
  });
});
