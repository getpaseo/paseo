import pino from "pino";
import { Readable } from "node:stream";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { SpeechToTextProvider, TextToSpeechProvider } from "../../speech-provider.js";
import { LAB_DEFAULT_TTS_VOICE, resolveLabSpeechConfig } from "./config.js";
import { applyLabSpeechServices } from "./runtime.js";
import { LabSTT, resamplePcm16 } from "./stt.js";
import { LabTTS } from "./tts.js";

const logger = pino({ level: "silent" });
const servers: WebSocketServer[] = [];

type LabMessageHandler = (ws: WebSocket, data: RawData, isBinary: boolean) => void;

async function fakeLab(onMessage: LabMessageHandler): Promise<string> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  server.on("connection", (ws) => {
    ws.on("message", (data, isBinary) => onMessage(ws, data, isBinary));
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("no port");
  return `ws://127.0.0.1:${address.port}`;
}

async function deadUrl(): Promise<string> {
  const url = await fakeLab(() => {});
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  return url;
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => {
      for (const client of s.clients) client.terminate();
      return new Promise((r) => s.close(r));
    }),
  );
});

describe("resolveLabSpeechConfig", () => {
  test("defaults to the locked voice and no endpoints", () => {
    const config = resolveLabSpeechConfig({});
    expect(config.ttsUrl).toBeUndefined();
    expect(config.sttUrl).toBeUndefined();
    expect(config.ttsVoice).toBe(LAB_DEFAULT_TTS_VOICE);
  });

  test("reads endpoints and overrides from env", () => {
    const config = resolveLabSpeechConfig({
      PASEO_LAB_TTS_URL: "ws://tts.invalid/tts",
      PASEO_LAB_STT_URL: "ws://stt.invalid/stt",
      PASEO_LAB_TTS_VOICE: "af_heart",
      PASEO_LAB_CONNECT_TIMEOUT_MS: "250",
    });
    expect(config).toEqual({
      ttsUrl: "ws://tts.invalid/tts",
      sttUrl: "ws://stt.invalid/stt",
      ttsVoice: "af_heart",
      connectTimeoutMs: 250,
    });
  });
});

describe("LabTTS", () => {
  test("sends speak with the locked voice and streams PCM until done", async () => {
    const received: unknown[] = [];
    const url = await fakeLab((ws, data) => {
      received.push(JSON.parse(data.toString()));
      ws.send(Buffer.from([1, 0, 2, 0]));
      ws.send(Buffer.from([3, 0]));
      ws.send(JSON.stringify({ type: "done", first_audio_ms: 40 }));
    });
    const tts = new LabTTS(
      { url, voice: LAB_DEFAULT_TTS_VOICE, connectTimeoutMs: 1000, fallback: null },
      logger,
    );
    const result = await tts.synthesizeSpeech("Hello there.");
    expect(result.format).toBe("pcm;rate=24000");
    expect([...(await collect(result.stream))]).toEqual([1, 0, 2, 0, 3, 0]);
    expect(received).toEqual([
      { type: "speak", text: "Hello there.", voice: LAB_DEFAULT_TTS_VOICE },
    ]);
  });

  test("falls back when the lab is unreachable", async () => {
    const fallback: TextToSpeechProvider = {
      synthesizeSpeech: async () => ({
        stream: Readable.from([Buffer.from("stock")]),
        format: "pcm",
      }),
    };
    const tts = new LabTTS(
      { url: await deadUrl(), voice: "v", connectTimeoutMs: 500, fallback },
      logger,
    );
    const result = await tts.synthesizeSpeech("hi");
    expect((await collect(result.stream)).toString()).toBe("stock");
  });

  test("falls back when the lab answers with an error before audio", async () => {
    const url = await fakeLab((ws) => {
      ws.send(JSON.stringify({ type: "error", message: "bad voice" }));
    });
    const fallback: TextToSpeechProvider = {
      synthesizeSpeech: async () => ({
        stream: Readable.from([Buffer.from("stock")]),
        format: "pcm",
      }),
    };
    const tts = new LabTTS({ url, voice: "v", connectTimeoutMs: 500, fallback }, logger);
    expect((await collect((await tts.synthesizeSpeech("hi")).stream)).toString()).toBe("stock");
  });

  test("throws when the lab fails and there is no fallback", async () => {
    const tts = new LabTTS(
      { url: await deadUrl(), voice: "v", connectTimeoutMs: 500, fallback: null },
      logger,
    );
    await expect(tts.synthesizeSpeech("hi")).rejects.toThrow(/Lab TTS failed/);
  });

  test("sends cancel when the consumer destroys the stream early", async () => {
    let markCancelled: () => void = () => {};
    const cancelled = new Promise<void>((resolve) => {
      markCancelled = resolve;
    });
    const url = await fakeLab((ws, data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "speak") ws.send(Buffer.from([1, 0]));
      if (message.type === "cancel") markCancelled();
    });
    const tts = new LabTTS({ url, voice: "v", connectTimeoutMs: 500, fallback: null }, logger);
    (await tts.synthesizeSpeech("long text")).stream.destroy();
    await cancelled;
  });
});

describe("LabSTT", () => {
  test("streams PCM, sends end on commit, and maps partial/final", async () => {
    const frames: Array<Buffer | string> = [];
    const url = await fakeLab((ws, data, isBinary) => {
      if (isBinary) {
        frames.push(Buffer.from(data as Buffer));
        ws.send(JSON.stringify({ type: "partial", text: "hel" }));
        return;
      }
      frames.push(data.toString());
      ws.send(JSON.stringify({ type: "final", text: "hello world", ms: 80 }));
    });
    const stt = new LabSTT({ url, connectTimeoutMs: 1000, fallback: null }, logger);
    const session = stt.createSession({ logger, language: "en" });
    expect(session.requiredSampleRate).toBe(16000);
    const events: Array<{ transcript: string; isFinal: boolean; segmentId: string }> = [];
    let committed: { segmentId: string; previousSegmentId: string | null } | null = null;
    session.on("transcript", (e) => events.push(e));
    session.on("committed", (e) => {
      committed = e;
    });
    await session.connect();
    session.appendPcm16(Buffer.from([1, 0, 2, 0]));
    session.commit();
    await expect.poll(() => events.length).toBe(2);
    expect(events.map((e) => [e.transcript, e.isFinal])).toEqual([
      ["hel", false],
      ["hello world", true],
    ]);
    expect(committed!.segmentId).toBe(events[1]!.segmentId);
    expect(frames).toEqual([Buffer.from([1, 0, 2, 0]), JSON.stringify({ type: "end" })]);
    session.close();
  });

  test("delegates to the fallback session, resampling 16k to its rate", async () => {
    const appended: Buffer[] = [];
    const listeners: Record<string, (p: never) => void> = {};
    const fallback: SpeechToTextProvider = {
      id: "stock",
      createSession: () => ({
        requiredSampleRate: 32000,
        connect: async () => {},
        appendPcm16: (b) => appended.push(b),
        commit: () =>
          listeners.transcript?.({ segmentId: "s", transcript: "stock", isFinal: true } as never),
        clear: () => {},
        close: () => {},
        on: (event, handler) => {
          listeners[event] = handler as (p: never) => void;
          return undefined;
        },
      }),
    };
    const stt = new LabSTT({ url: await deadUrl(), connectTimeoutMs: 500, fallback }, logger);
    const session = stt.createSession({ logger });
    const transcripts: string[] = [];
    session.on("transcript", (e) => transcripts.push(e.transcript));
    await session.connect();
    session.appendPcm16(Buffer.from([0, 0, 100, 0, 200, 0, 44, 1]));
    session.commit();
    expect(appended[0]!.length).toBe(16);
    expect(transcripts).toEqual(["stock"]);
  });

  test("connect rejects when the lab is down and there is no fallback", async () => {
    const stt = new LabSTT({ url: await deadUrl(), connectTimeoutMs: 500, fallback: null }, logger);
    await expect(stt.createSession({ logger }).connect()).rejects.toThrow(/unavailable/);
  });
});

describe("resamplePcm16", () => {
  test("is identity for equal rates and doubles length for 2x", () => {
    const pcm = Buffer.from([0, 0, 100, 0]);
    expect(resamplePcm16(pcm, 16000, 16000)).toBe(pcm);
    expect(resamplePcm16(pcm, 16000, 32000).length).toBe(8);
  });
});

describe("applyLabSpeechServices", () => {
  const providers = {
    dictationStt: { provider: "local", explicit: false, enabled: true },
    voiceTurnDetection: { provider: "local", explicit: false, enabled: true },
    voiceStt: { provider: "local", explicit: false, enabled: true },
    voiceTts: { provider: "local", explicit: false, enabled: true },
  } as const;
  const existing = {
    turnDetectionService: null,
    sttService: null,
    ttsService: null,
    dictationSttService: null,
  };

  test("leaves services untouched without endpoints", () => {
    const result = applyLabSpeechServices({
      providers,
      existing,
      logger,
      config: { ttsVoice: "v", connectTimeoutMs: 100 },
    });
    expect(result).toEqual(existing);
  });

  test("wraps voice stt and tts when endpoints are set", () => {
    const result = applyLabSpeechServices({
      providers,
      existing,
      logger,
      config: {
        ttsUrl: "ws://x.invalid/tts",
        sttUrl: "ws://x.invalid/stt",
        ttsVoice: "v",
        connectTimeoutMs: 100,
      },
    });
    expect(result.ttsService).toBeInstanceOf(LabTTS);
    expect(result.sttService?.id).toBe("lab");
    expect(result.dictationSttService).toBeNull();
  });
});
