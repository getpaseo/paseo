import pino from "pino";
import { describe, expect, test, vi } from "vitest";

import type { GeminiSttConfig } from "./config.js";
import type { GeminiLiveTranscriptionApi, GeminiLiveTranscriptionConnection } from "./stt.js";
import { GeminiSTT } from "./stt.js";

interface FakeLiveApi {
  api: GeminiLiveTranscriptionApi;
  activities: string[];
  audio: Buffer[];
  configs: GeminiSttConfig[];
  emitPartial(text: string, language?: string): void;
  emitFinal(text: string, language?: string): void;
  emitError(error: Error): void;
}

function createLiveApi(): FakeLiveApi {
  const activities: string[] = [];
  const audio: Buffer[] = [];
  const configs: GeminiSttConfig[] = [];
  let emitPartial: FakeLiveApi["emitPartial"] = () => {};
  let emitFinal: FakeLiveApi["emitFinal"] = () => {};
  let emitError: FakeLiveApi["emitError"] = () => {};

  const connection: GeminiLiveTranscriptionConnection = {
    startActivity() {
      activities.push("start");
    },
    sendAudio(pcm16) {
      audio.push(pcm16);
    },
    endActivity() {
      activities.push("end");
    },
    close() {
      activities.push("close");
    },
  };
  const api: GeminiLiveTranscriptionApi = {
    async connect(config, callbacks) {
      configs.push(config);
      emitPartial = callbacks.onPartial;
      emitFinal = callbacks.onFinal;
      emitError = callbacks.onError;
      return connection;
    },
  };

  return {
    api,
    activities,
    audio,
    configs,
    emitPartial: (text, language) => emitPartial(text, language),
    emitFinal: (text, language) => emitFinal(text, language),
    emitError: (error) => emitError(error),
  };
}

function createProvider(live: FakeLiveApi): GeminiSTT {
  return new GeminiSTT({
    apiKey: "gemini-test-key",
    config: { model: "gemini-3.5-transcribe-live", language: "zh-CN", mode: "smart" },
    logger: pino({ level: "silent" }),
    api: live.api,
  });
}

describe("GeminiSTT", () => {
  test("streams PCM and maps partial and final transcripts to the committed segment", async () => {
    const live = createLiveApi();
    const session = createProvider(live).createSession({ logger: pino({ level: "silent" }) });
    const committed: Array<{ segmentId: string; previousSegmentId: string | null }> = [];
    const transcripts: Array<{
      segmentId: string;
      transcript: string;
      isFinal: boolean;
      language?: string;
    }> = [];
    session.on("committed", (event) => committed.push(event));
    session.on("transcript", (event) => transcripts.push(event));

    await session.connect();
    session.appendPcm16(Buffer.from([1, 0]));
    session.appendPcm16(Buffer.from([2, 0]));
    live.emitPartial("你好", "zh-CN");
    session.commit();
    live.emitFinal("你好世界", "zh-CN");

    expect(live.configs).toEqual([
      {
        model: "gemini-3.5-transcribe-live",
        language: "zh-CN",
        mode: "smart",
      },
    ]);
    expect(live.activities).toEqual(["start", "end"]);
    expect(live.audio).toEqual([Buffer.from([1, 0]), Buffer.from([2, 0])]);
    expect(committed).toHaveLength(1);
    expect(committed[0]?.previousSegmentId).toBeNull();
    expect(transcripts).toEqual([
      {
        segmentId: committed[0]?.segmentId,
        transcript: "你好",
        isFinal: false,
        language: "zh-CN",
      },
      {
        segmentId: committed[0]?.segmentId,
        transcript: "你好世界",
        isFinal: true,
        language: "zh-CN",
      },
    ]);
  });

  test("preserves segment order across consecutive live activities", async () => {
    const live = createLiveApi();
    const session = createProvider(live).createSession({ logger: pino({ level: "silent" }) });
    const committed: Array<{ segmentId: string; previousSegmentId: string | null }> = [];
    const finals: Array<{ segmentId: string; transcript: string }> = [];
    session.on("committed", (event) => committed.push(event));
    session.on("transcript", (event) => {
      if (event.isFinal) {
        finals.push({ segmentId: event.segmentId, transcript: event.transcript });
      }
    });

    await session.connect();
    session.appendPcm16(Buffer.from([1, 0]));
    session.commit();
    session.appendPcm16(Buffer.from([2, 0]));
    session.commit();
    live.emitFinal("first");
    live.emitFinal("second");

    expect(committed).toHaveLength(2);
    expect(committed[1]?.previousSegmentId).toBe(committed[0]?.segmentId);
    expect(finals).toEqual([
      { segmentId: committed[0]?.segmentId, transcript: "first" },
      { segmentId: committed[1]?.segmentId, transcript: "second" },
    ]);
    expect(live.activities).toEqual(["start", "end", "start", "end"]);
  });

  test("clears a segment without requiring a silence transcript from Gemini", async () => {
    const live = createLiveApi();
    const session = createProvider(live).createSession({ logger: pino({ level: "silent" }) });
    const committed: string[] = [];
    const transcripts = vi.fn();
    session.on("committed", ({ segmentId }) => committed.push(segmentId));
    session.on("transcript", transcripts);

    await session.connect();
    session.appendPcm16(Buffer.from([0, 0]));
    session.clear();
    session.appendPcm16(Buffer.from([1, 0]));
    session.commit();
    live.emitFinal("kept");

    expect(live.activities).toEqual(["start", "end"]);
    expect(committed).toHaveLength(1);
    expect(transcripts).toHaveBeenCalledOnce();
    expect(transcripts.mock.calls[0]?.[0]).toEqual({
      segmentId: committed[0],
      transcript: "kept",
      isFinal: true,
    });
  });

  test("hides live provider errors", async () => {
    const live = createLiveApi();
    const session = createProvider(live).createSession({ logger: pino({ level: "silent" }) });
    const error = vi.fn();
    session.on("error", error);

    await session.connect();
    live.emitError(new Error("internal websocket response"));

    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]?.[0]).toEqual(new Error("Gemini live transcription failed"));
  });

  test("hides live connection errors", async () => {
    const api: GeminiLiveTranscriptionApi = {
      async connect() {
        throw new Error("internal handshake response");
      },
    };
    const provider = new GeminiSTT({
      apiKey: "gemini-test-key",
      config: { model: "gemini-3.5-transcribe-live", mode: "smart" },
      logger: pino({ level: "silent" }),
      api,
    });
    const session = provider.createSession({ logger: pino({ level: "silent" }) });

    await expect(session.connect()).rejects.toHaveProperty(
      "message",
      "Gemini live transcription connection failed",
    );
  });
});
