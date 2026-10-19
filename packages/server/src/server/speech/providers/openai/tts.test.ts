import { once } from "node:events";
import pino from "pino";
import { describe, expect, test } from "vitest";
import { OpenAITTS } from "./tts.js";

const logger = pino({ level: "silent" });

async function collect(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

describe("OpenAITTS", () => {
  test("keeps OpenAI defaults and API key authentication", async () => {
    const requests: Request[] = [];
    const provider = new OpenAITTS(
      { apiKey: "test-key", baseUrl: "https://speech.example/v1" },
      logger,
      async (url, init) => {
        requests.push(new Request(url, init));
        return new Response(new Uint8Array([0, 1]));
      },
    );
    const result = await provider.synthesizeSpeech("Hello");
    expect(await collect(result.stream)).toEqual(Buffer.from([0, 1]));
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://speech.example/v1/audio/speech");
    expect(requests[0].headers.get("authorization")).toBe("Bearer test-key");
    expect(await requests[0].json()).toEqual({
      model: "tts-1",
      voice: "alloy",
      input: "Hello",
      response_format: "pcm",
    });
    expect(result.format).toBe("pcm");
  });

  test("sends custom names without authentication and preserves odd-sized PCM reads", async () => {
    const requests: Request[] = [];
    const provider = new OpenAITTS(
      {
        auth: "none",
        baseUrl: "http://127.0.0.1:18081/v1",
        model: "Example/Custom-8bit",
        voice: "Vivian",
      },
      logger,
      async (url, init) => {
        requests.push(new Request(url, init));
        expect(init?.redirect).toBe("error");
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([0]));
              controller.enqueue(new Uint8Array([1, 2, 3]));
              controller.close();
            },
          }),
        );
      },
    );
    const result = await provider.synthesizeSpeech("你好");
    expect(await collect(result.stream)).toEqual(Buffer.from([0, 1, 2, 3]));
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("http://127.0.0.1:18081/v1/audio/speech");
    expect(requests[0].headers.get("authorization")).toBeNull();
    expect(requests[0].headers.get("api-key")).toBeNull();
    expect(await requests[0].json()).toEqual({
      model: "Example/Custom-8bit",
      voice: "Vivian",
      input: "你好",
      response_format: "pcm",
    });
  });

  test("destroying the Node stream cancels the response body", async () => {
    let cancelled = false;
    const provider = new OpenAITTS(
      { auth: "none", baseUrl: "http://127.0.0.1:18081/v1" },
      logger,
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        ),
    );
    const result = await provider.synthesizeSpeech("Hello");
    const closed = once(result.stream, "close");
    result.stream.destroy();
    await closed;
    expect(cancelled).toBe(true);
  });

  test("aborts a synthesis request before response headers arrive", async () => {
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let aborted = false;
    const provider = new OpenAITTS(
      { auth: "none", baseUrl: "http://127.0.0.1:18081/v1" },
      logger,
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
          started();
        }),
    );
    const controller = new AbortController();
    const pending = provider.synthesizeSpeech("Hello", controller.signal);
    const rejected = expect(pending).rejects.toThrow("TTS synthesis failed");
    await requestStarted;
    controller.abort();
    await rejected;
    expect(aborted).toBe(true);
  });

  test("surfaces local endpoint failure without retry or cloud fallback", async () => {
    const urls: string[] = [];
    const provider = new OpenAITTS(
      { auth: "none", baseUrl: "http://127.0.0.1:18081/v1" },
      logger,
      async (url) => {
        urls.push(String(url));
        return new Response("Endpoint unavailable", { status: 503 });
      },
    );
    await expect(provider.synthesizeSpeech("Hello")).rejects.toThrow("503");
    expect(urls).toEqual(["http://127.0.0.1:18081/v1/audio/speech"]);
  });

  test("rejects missing credentials before creating a cloud client", () => {
    expect(() => new OpenAITTS({}, logger)).toThrow("OpenAI speech requires");
    expect(() => new OpenAITTS({ auth: "none" }, logger)).toThrow("loopback baseUrl");
  });
});
