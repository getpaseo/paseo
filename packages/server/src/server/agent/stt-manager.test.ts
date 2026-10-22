import { describe, expect, it } from "vitest";
import pino from "pino";
import { EventEmitter } from "node:events";

import { STTManager } from "./stt-manager.js";
import { PersistedConfigSchema } from "../persisted-config.js";
import { resolveSpeechConfig } from "../speech/speech-config-resolver.js";
import type {
  SpeechToTextProvider,
  StreamingTranscriptionSession,
  TranscriptionResult,
} from "../speech/speech-provider.js";

type SessionParams = Parameters<SpeechToTextProvider["createSession"]>[0];
type StreamingOn = StreamingTranscriptionSession["on"];
type StreamingOnEvent = Parameters<StreamingOn>[0];
type StreamingOnHandler = Parameters<StreamingOn>[1];

class FakeStt implements SpeechToTextProvider {
  public readonly id = "fake";
  public lastLanguage?: string;
  constructor(private readonly result: TranscriptionResult) {}

  createSession(params: SessionParams): StreamingTranscriptionSession {
    this.lastLanguage = params.language;
    const emitter = new EventEmitter();
    const result = this.result;
    let segmentId = "seg-1";
    let previousSegmentId: string | null = null;

    return {
      requiredSampleRate: 24000,
      async connect() {},
      appendPcm16() {},
      commit() {
        emitter.emit("committed", { segmentId, previousSegmentId });
        emitter.emit("transcript", {
          segmentId,
          transcript: result.text,
          isFinal: true,
          language: result.language,
          logprobs: result.logprobs,
          avgLogprob: result.avgLogprob,
          isLowConfidence: result.isLowConfidence,
        });
        previousSegmentId = segmentId;
        segmentId = "seg-2";
      },
      clear() {},
      close() {},
      on(event: StreamingOnEvent, handler: StreamingOnHandler) {
        emitter.on(event, handler as (...args: unknown[]) => void);
        return undefined;
      },
    };
  }
}

class SequencedFakeStt implements SpeechToTextProvider {
  public readonly id = "fake-sequenced";
  constructor(private readonly transcripts: string[]) {}

  createSession(_params: SessionParams): StreamingTranscriptionSession {
    const emitter = new EventEmitter();
    const transcripts = this.transcripts;
    let segmentId = "seg-1";
    let previousSegmentId: string | null = null;
    let idx = 0;

    return {
      requiredSampleRate: 24000,
      async connect() {},
      appendPcm16() {},
      commit() {
        const transcript = transcripts[idx] ?? "";
        idx += 1;
        emitter.emit("committed", { segmentId, previousSegmentId });
        emitter.emit("transcript", {
          segmentId,
          transcript,
          isFinal: true,
          language: "en",
          isLowConfidence: transcript.length === 0,
        });
        previousSegmentId = segmentId;
        segmentId = `seg-${idx + 1}`;
      },
      clear() {},
      close() {},
      on(event: StreamingOnEvent, handler: StreamingOnHandler) {
        emitter.on(event, handler as (...args: unknown[]) => void);
        return undefined;
      },
    };
  }
}

describe("STTManager", () => {
  function resolveVoiceLanguage(params: { env?: NodeJS.ProcessEnv; persisted?: unknown }): string {
    const result = resolveSpeechConfig({
      paseoHome: "/tmp/paseo-home",
      env: params.env ?? ({} as NodeJS.ProcessEnv),
      persisted: PersistedConfigSchema.parse(params.persisted ?? {}),
    });
    return result.speech.sttLanguages.voice;
  }

  async function transcribeWithResolvedVoiceLanguage(params: {
    env?: NodeJS.ProcessEnv;
    persisted?: unknown;
  }): Promise<FakeStt> {
    const fakeStt = new FakeStt({ text: "hi", isLowConfidence: false });
    const manager = new STTManager("s1", pino({ level: "silent" }), fakeStt, {
      language: resolveVoiceLanguage(params),
    });
    await manager.transcribe(Buffer.alloc(2), "audio/pcm;rate=24000");
    return fakeStt;
  }

  it("defaults to English when no voice language config is set", async () => {
    const fakeStt = await transcribeWithResolvedVoiceLanguage({});

    expect(fakeStt.lastLanguage).toBe("en");
  });

  it("uses PASEO_VOICE_LANGUAGE over PASEO_DICTATION_LANGUAGE", async () => {
    const fakeStt = await transcribeWithResolvedVoiceLanguage({
      env: {
        PASEO_VOICE_LANGUAGE: "pt",
        PASEO_DICTATION_LANGUAGE: "es",
      } as NodeJS.ProcessEnv,
    });

    expect(fakeStt.lastLanguage).toBe("pt");
  });

  it("uses PASEO_DICTATION_LANGUAGE when PASEO_VOICE_LANGUAGE is unset", async () => {
    const fakeStt = await transcribeWithResolvedVoiceLanguage({
      env: {
        PASEO_DICTATION_LANGUAGE: "pt",
      } as NodeJS.ProcessEnv,
    });

    expect(fakeStt.lastLanguage).toBe("pt");
  });

  it("treats empty voice language env vars as unset", async () => {
    const fakeStt = await transcribeWithResolvedVoiceLanguage({
      env: {
        PASEO_VOICE_LANGUAGE: "",
        PASEO_DICTATION_LANGUAGE: "  ",
      } as NodeJS.ProcessEnv,
    });

    expect(fakeStt.lastLanguage).toBe("en");
  });

  it("uses settings voice STT language when no env var is set", async () => {
    const fakeStt = await transcribeWithResolvedVoiceLanguage({
      persisted: {
        features: {
          voiceMode: {
            stt: {
              language: "fr",
            },
          },
        },
      },
    });

    expect(fakeStt.lastLanguage).toBe("fr");
  });

  it("uses env voice language over settings voice STT language", async () => {
    const fakeStt = await transcribeWithResolvedVoiceLanguage({
      env: {
        PASEO_VOICE_LANGUAGE: "pt",
      } as NodeJS.ProcessEnv,
      persisted: {
        features: {
          voiceMode: {
            stt: {
              language: "fr",
            },
          },
        },
      },
    });

    expect(fakeStt.lastLanguage).toBe("pt");
  });

  it("falls back to settings dictation STT language when voice language is unset", async () => {
    const fakeStt = await transcribeWithResolvedVoiceLanguage({
      persisted: {
        features: {
          dictation: {
            stt: {
              language: "es",
            },
          },
        },
      },
    });

    expect(fakeStt.lastLanguage).toBe("es");
  });

  it("returns empty text for low-confidence transcriptions", async () => {
    const manager = new STTManager(
      "s1",
      pino({ level: "silent" }),
      new FakeStt({ text: "um", isLowConfidence: true, avgLogprob: -10 }),
    );

    const result = await manager.transcribe(Buffer.alloc(2), "audio/pcm;rate=24000", {
      label: "t",
    });
    expect(result.text).toBe("");
    expect(result.isLowConfidence).toBe(true);
    expect(result.byteLength).toBe(2);
  });

  it("passes through normal transcriptions", async () => {
    const manager = new STTManager(
      "s1",
      pino({ level: "silent" }),
      new FakeStt({ text: "hello world", language: "en", isLowConfidence: false }),
    );

    const result = await manager.transcribe(Buffer.alloc(4), "audio/pcm;rate=24000");
    expect(result.text).toBe("hello world");
    expect(result.language).toBe("en");
    expect(result.byteLength).toBe(4);
  });

  it("uses streaming segmentation for batch transcription and concatenates segment finals", async () => {
    const original = process.env.PASEO_STT_BATCH_COMMIT_EVERY_SECONDS;
    process.env.PASEO_STT_BATCH_COMMIT_EVERY_SECONDS = "1";

    try {
      const manager = new STTManager(
        "s1",
        pino({ level: "silent" }),
        new SequencedFakeStt(["alpha", "beta", "gamma"]),
      );

      const threeSecondsPcm = Buffer.alloc(24000 * 2 * 3);
      const result = await manager.transcribe(threeSecondsPcm, "audio/pcm;rate=24000");

      expect(result.text).toBe("alpha beta gamma");
      expect(result.language).toBe("en");
      expect(result.byteLength).toBe(threeSecondsPcm.length);
    } finally {
      if (original === undefined) {
        delete process.env.PASEO_STT_BATCH_COMMIT_EVERY_SECONDS;
      } else {
        process.env.PASEO_STT_BATCH_COMMIT_EVERY_SECONDS = original;
      }
    }
  });
});
