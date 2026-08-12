import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import { MiniMaxTTS, resolveMiniMaxTtsUrls } from "./tts.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("MiniMaxTTS", () => {
  test("routes global and China operations to their regional hosts", () => {
    expect(resolveMiniMaxTtsUrls({ apiKey: "test", region: "global_en" })).toEqual({
      synthesis: "https://api.minimax.io/v1/t2a_v2",
      asyncCreate: "https://api.minimax.io/v1/t2a_async_v2",
      asyncQuery: "https://api.minimax.io/v1/query/t2a_async_query_v2",
      websocket: "wss://api.minimax.io/ws/v1/t2a_v2",
    });
    expect(resolveMiniMaxTtsUrls({ apiKey: "test", region: "cn_zh" })).toEqual({
      synthesis: "https://api.minimaxi.com/v1/t2a_v2",
      asyncCreate: "https://api.minimaxi.com/v1/t2a_async_v2",
      asyncQuery: "https://api.minimaxi.com/v1/query/t2a_async_query_v2",
      websocket: "wss://api.minimaxi.com/ws/v1/t2a_v2",
    });
  });

  test("synthesizes hex audio with the complete request options", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ data: { audio: "6869", status: "success" }, base_resp: { status_code: 0 } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new MiniMaxTTS(
      {
        apiKey: "test-key",
        region: "cn_zh",
        model: "speech-2.8-turbo",
        voiceId: "test-voice",
        responseFormat: "wav",
      },
      pino({ level: "silent" }),
    );

    const result = await provider.synthesizeSpeech("hello", {
      languageBoost: "English",
      pronunciationDictionary: { tone: ["Paseo/(pəˈseɪoʊ)"] },
      voiceModify: { pitch: 2 },
      subtitleEnabled: true,
      audioSetting: { format: "pcm", sampleRate: 32_000, bitrate: 128_000, channel: 1 },
    });
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) chunks.push(Buffer.from(chunk));

    expect(Buffer.concat(chunks).toString()).toBe("hi");
    expect(result.format).toBe("pcm");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.minimaxi.com/v1/t2a_v2",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
        },
      }),
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      model: "speech-2.8-turbo",
      text: "hello",
      stream: false,
      output_format: "hex",
      language_boost: "English",
      voice_setting: { voice_id: "test-voice" },
      pronunciation_dict: { tone: ["Paseo/(pəˈseɪoʊ)"] },
      audio_setting: { format: "pcm", sample_rate: 32_000, bitrate: 128_000, channel: 1 },
      voice_modify: { pitch: 2 },
      subtitle_enable: true,
    });
  });

  test("supports asynchronous create and query operations", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ task_id: "task-1", task_token: "token-1", file_id: 12 }),
      )
      .mockResolvedValueOnce(jsonResponse({ task_id: "task-1", status: "Success", file_id: 12 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new MiniMaxTTS({ apiKey: "test-key" }, pino({ level: "silent" }));

    await expect(provider.createAsyncSpeech("hello")).resolves.toEqual({
      taskId: "task-1",
      taskToken: "token-1",
      fileId: 12,
    });
    await expect(provider.queryAsyncSpeech("task-1")).resolves.toEqual({
      taskId: "task-1",
      status: "Success",
      fileId: 12,
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://api.minimax.io/v1/t2a_async_v2",
      "https://api.minimax.io/v1/query/t2a_async_query_v2",
    ]);
    const createRequest = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(createRequest?.body))).toEqual({
      model: "speech-2.8-hd",
      text: "hello",
      audio_setting: { format: "mp3" },
    });
    const queryRequest = fetchMock.mock.calls[1]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(queryRequest?.body))).toEqual({
      task_id: "task-1",
    });
  });

  test("builds a streaming WebSocket request with required fields", () => {
    const provider = new MiniMaxTTS(
      { apiKey: "test-key", model: "speech-01-hd" },
      pino({ level: "silent" }),
    );

    expect(provider.buildWebSocketRequest("hello")).toEqual({
      model: "speech-01-hd",
      text: "hello",
      stream: true,
      output_format: "hex",
      audio_setting: { format: "mp3" },
    });
  });
});
