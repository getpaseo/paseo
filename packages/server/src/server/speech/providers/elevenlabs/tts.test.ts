import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

vi.stubGlobal("fetch", fetchMock);

import { ElevenLabsTTS } from "./tts.js";

function makeAudioStream(chunks: Array<Uint8Array>): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index] ?? new Uint8Array(0));
      index += 1;
    },
  });
}

describe("ElevenLabsTTS", () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  test("POSTs voice_id/text/model_id to the ElevenLabs TTS endpoint", async () => {
    fetchMock.mockResolvedValue(
      new Response(makeAudioStream([new Uint8Array([1, 2, 3])]), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      }),
    );

    const provider = new ElevenLabsTTS(
      {
        apiKey: "test-key",
        voiceId: "21m00Tcm4TlvDq8ikWAM",
        modelId: "eleven_multilingual_v2",
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

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
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
    fetchMock.mockResolvedValue(
      new Response(makeAudioStream([new Uint8Array([0])]), { status: 200 }),
    );

    const provider = new ElevenLabsTTS(
      { apiKey: "k", voiceId: "voice/with/slash" },
      pino({ level: "silent" }),
    );
    await provider.synthesizeSpeech("hi");

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("/v1/text-to-speech/voice%2Fwith%2Fslash");
  });

  test("throws on empty input", async () => {
    const provider = new ElevenLabsTTS({ apiKey: "k", voiceId: "v" }, pino({ level: "silent" }));
    await expect(provider.synthesizeSpeech("   ")).rejects.toThrow(/empty/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("throws with the API detail message on a non-2xx response", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: { message: "voice not found" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );

    const provider = new ElevenLabsTTS({ apiKey: "k", voiceId: "v" }, pino({ level: "silent" }));

    await expect(provider.synthesizeSpeech("hi")).rejects.toThrow(/voice not found/);
  });
});
