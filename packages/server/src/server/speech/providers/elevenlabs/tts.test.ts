import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ElevenLabsTTS } from "./tts.js";

function makeFetch(
  responses: Array<{ status: number; body: Uint8Array[] | null; detailMessage?: string }>,
): typeof fetch {
  let index = 0;
  const fn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const next = responses[index] ?? responses[responses.length - 1];
    if (!next) {
      throw new Error("no more responses");
    }
    index += 1;
    if (next.detailMessage) {
      return new Response(JSON.stringify({ detail: { message: next.detailMessage } }), {
        status: next.status,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      new ReadableStream({
        pull(controller) {
          for (const chunk of next.body ?? []) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      }),
      { status: next.status, headers: { "content-type": "audio/mpeg" } },
    );
  });
  return fn as unknown as typeof fetch;
}

describe("ElevenLabsTTS", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("POSTs voice_id/text/model_id to the ElevenLabs TTS endpoint", async () => {
    const fetchImpl = makeFetch([{ status: 200, body: [new Uint8Array([1, 2, 3])] }]);
    const provider = new ElevenLabsTTS(
      {
        apiKey: "test-key",
        voiceId: "21m00Tcm4TlvDq8ikWAM",
        modelId: "eleven_multilingual_v2",
        fetchImpl,
      },
      pino({ level: "silent" }),
    );

    const { stream, format } = await provider.synthesizeSpeech("hi there");

    expect(format).toBe("mp3");
    const collected: number[] = [];
    for await (const chunk of stream) {
      for (const byte of chunk) {
        collected.push(byte);
      }
    }
    expect(collected).toEqual([1, 2, 3]);

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toContain("/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM");
    expect(url).toContain("output_format=mp3_44100_128");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["xi-api-key"]).toBe("test-key");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      text: "hi there",
      model_id: "eleven_multilingual_v2",
    });
  });

  test("encodes the voiceId in the URL path", async () => {
    const fetchImpl = makeFetch([{ status: 200, body: [new Uint8Array([0])] }]);
    const provider = new ElevenLabsTTS(
      { apiKey: "k", voiceId: "voice/with/slash", fetchImpl },
      pino({ level: "silent" }),
    );
    await provider.synthesizeSpeech("hi");

    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain("/v1/text-to-speech/voice%2Fwith%2Fslash");
  });

  test("throws on empty input without calling fetch", async () => {
    const fetchImpl = makeFetch([{ status: 200, body: [] }]);
    const provider = new ElevenLabsTTS(
      { apiKey: "k", voiceId: "v", fetchImpl },
      pino({ level: "silent" }),
    );
    await expect(provider.synthesizeSpeech("   ")).rejects.toThrow(/empty/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("throws with the API detail message on a non-2xx response", async () => {
    const fetchImpl = makeFetch([{ status: 400, body: null, detailMessage: "voice not found" }]);
    const provider = new ElevenLabsTTS(
      { apiKey: "k", voiceId: "v", fetchImpl },
      pino({ level: "silent" }),
    );

    await expect(provider.synthesizeSpeech("hi")).rejects.toThrow(/voice not found/);
  });
});
