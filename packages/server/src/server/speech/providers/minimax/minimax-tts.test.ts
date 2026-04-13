import { Readable } from "node:stream";
import pino from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMiniMaxSpeechConfig } from "./config.js";
import { MiniMaxTTS } from "./tts.js";

const silentLogger = pino({ level: "silent" });

describe("MiniMaxTTS", () => {
  it("creates instance with valid config", () => {
    const tts = new MiniMaxTTS({ apiKey: "test-key" }, silentLogger);
    expect(tts).toBeDefined();
  });

  it("uses default model and voice", () => {
    const tts = new MiniMaxTTS({ apiKey: "test-key" }, silentLogger);
    const config = tts.getConfig();
    expect(config.model).toBe("speech-2.8-hd");
    expect(config.voice).toBe("English_Graceful_Lady");
  });

  it("uses default base URL", () => {
    const tts = new MiniMaxTTS({ apiKey: "test-key" }, silentLogger);
    const config = tts.getConfig();
    expect(config.baseUrl).toBe("https://api.minimax.io");
  });

  it("accepts custom model and voice", () => {
    const tts = new MiniMaxTTS(
      { apiKey: "test-key", model: "speech-2.8-turbo", voice: "English_Persuasive_Man" },
      silentLogger,
    );
    const config = tts.getConfig();
    expect(config.model).toBe("speech-2.8-turbo");
    expect(config.voice).toBe("English_Persuasive_Man");
  });

  it("accepts custom base URL", () => {
    const tts = new MiniMaxTTS(
      { apiKey: "test-key", baseUrl: "https://custom.example.com" },
      silentLogger,
    );
    const config = tts.getConfig();
    expect(config.baseUrl).toBe("https://custom.example.com");
  });

  it("throws on empty text", async () => {
    const tts = new MiniMaxTTS({ apiKey: "test-key" }, silentLogger);
    await expect(tts.synthesizeSpeech("")).rejects.toThrow("Cannot synthesize empty text");
    await expect(tts.synthesizeSpeech("   ")).rejects.toThrow("Cannot synthesize empty text");
  });

  it("synthesizes speech and returns mp3 stream", async () => {
    const hexAudio = Buffer.from("fake-audio-data").toString("hex");
    const sseResponse = [
      `data: ${JSON.stringify({ data: { audio: hexAudio, status: 1 }, base_resp: { status_code: 0 } })}\n\n`,
      `data: ${JSON.stringify({ data: { audio: "", status: 2 }, base_resp: { status_code: 0 } })}\n\n`,
    ].join("");

    const mockBody = {
      getReader: () => {
        const encoder = new TextEncoder();
        const data = encoder.encode(sseResponse);
        let done = false;
        return {
          read: async () => {
            if (done) return { done: true, value: undefined };
            done = true;
            return { done: false, value: data };
          },
          releaseLock: () => {},
        };
      },
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      body: mockBody,
    });

    vi.stubGlobal("fetch", mockFetch);

    try {
      const tts = new MiniMaxTTS({ apiKey: "test-key" }, silentLogger);
      const result = await tts.synthesizeSpeech("Hello, world!");

      expect(result.format).toBe("mp3");
      expect(result.stream).toBeInstanceOf(Readable);

      const chunks: Buffer[] = [];
      for await (const chunk of result.stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const audioBuffer = Buffer.concat(chunks);
      expect(audioBuffer.equals(Buffer.from("fake-audio-data"))).toBe(true);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.minimax.io/v1/t2a_v2",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer test-key",
            "Content-Type": "application/json",
          }),
        }),
      );

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(requestBody.model).toBe("speech-2.8-hd");
      expect(requestBody.stream).toBe(true);
      expect(requestBody.voice_setting.voice_id).toBe("English_Graceful_Lady");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("throws when API returns error status", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });

    vi.stubGlobal("fetch", mockFetch);

    try {
      const tts = new MiniMaxTTS({ apiKey: "bad-key" }, silentLogger);
      await expect(tts.synthesizeSpeech("Hello")).rejects.toThrow("MiniMax TTS synthesis failed");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("throws when API returns error in SSE body", async () => {
    const sseResponse = `data: ${JSON.stringify({ base_resp: { status_code: 2013, status_msg: "invalid voice_id" } })}\n\n`;

    const mockBody = {
      getReader: () => {
        const encoder = new TextEncoder();
        const data = encoder.encode(sseResponse);
        let done = false;
        return {
          read: async () => {
            if (done) return { done: true, value: undefined };
            done = true;
            return { done: false, value: data };
          },
          releaseLock: () => {},
        };
      },
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      body: mockBody,
    });

    vi.stubGlobal("fetch", mockFetch);

    try {
      const tts = new MiniMaxTTS({ apiKey: "test-key" }, silentLogger);
      await expect(tts.synthesizeSpeech("Hello")).rejects.toThrow("MiniMax TTS synthesis failed");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("removes trailing slash from base URL", async () => {
    const hexAudio = Buffer.from("audio").toString("hex");
    const sseResponse = `data: ${JSON.stringify({ data: { audio: hexAudio, status: 2 }, base_resp: { status_code: 0 } })}\n\n`;

    const mockBody = {
      getReader: () => {
        const encoder = new TextEncoder();
        const data = encoder.encode(sseResponse);
        let done = false;
        return {
          read: async () => {
            if (done) return { done: true, value: undefined };
            done = true;
            return { done: false, value: data };
          },
          releaseLock: () => {},
        };
      },
    };

    const mockFetch = vi.fn().mockResolvedValue({ ok: true, body: mockBody });
    vi.stubGlobal("fetch", mockFetch);

    try {
      const tts = new MiniMaxTTS(
        { apiKey: "test-key", baseUrl: "https://api.minimax.io/" },
        silentLogger,
      );
      await tts.synthesizeSpeech("Hello");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.minimax.io/v1/t2a_v2",
        expect.any(Object),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("resolveMiniMaxSpeechConfig", () => {
  it("returns undefined when MINIMAX_API_KEY is not set", () => {
    const result = resolveMiniMaxSpeechConfig({ env: {} as NodeJS.ProcessEnv });
    expect(result).toBeUndefined();
  });

  it("returns undefined when MINIMAX_API_KEY is empty", () => {
    const result = resolveMiniMaxSpeechConfig({
      env: { MINIMAX_API_KEY: "" } as NodeJS.ProcessEnv,
    });
    expect(result).toBeUndefined();
  });

  it("resolves config with API key", () => {
    const result = resolveMiniMaxSpeechConfig({
      env: { MINIMAX_API_KEY: "test-key" } as NodeJS.ProcessEnv,
    });
    expect(result).toBeDefined();
    expect(result?.apiKey).toBe("test-key");
    expect(result?.tts?.model).toBe("speech-2.8-hd");
    expect(result?.tts?.voice).toBe("English_Graceful_Lady");
  });

  it("applies custom model from env", () => {
    const result = resolveMiniMaxSpeechConfig({
      env: {
        MINIMAX_API_KEY: "test-key",
        MINIMAX_TTS_MODEL: "speech-2.8-turbo",
      } as NodeJS.ProcessEnv,
    });
    expect(result?.tts?.model).toBe("speech-2.8-turbo");
  });

  it("applies custom voice from env", () => {
    const result = resolveMiniMaxSpeechConfig({
      env: {
        MINIMAX_API_KEY: "test-key",
        MINIMAX_TTS_VOICE: "English_Persuasive_Man",
      } as NodeJS.ProcessEnv,
    });
    expect(result?.tts?.voice).toBe("English_Persuasive_Man");
  });

  it("applies custom base URL from env", () => {
    const result = resolveMiniMaxSpeechConfig({
      env: {
        MINIMAX_API_KEY: "test-key",
        MINIMAX_BASE_URL: "https://custom.api.com",
      } as NodeJS.ProcessEnv,
    });
    expect(result?.tts?.baseUrl).toBe("https://custom.api.com");
  });
});
