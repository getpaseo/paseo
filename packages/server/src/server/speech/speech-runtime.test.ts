import { beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";

import type { PaseoSpeechConfig } from "../bootstrap.js";
import type { InitializedLocalSpeech } from "./providers/local/runtime.js";
import type { SpeechToTextProvider, TextToSpeechProvider } from "./speech-provider.js";
import type { TurnDetectionProvider } from "./turn-detection-provider.js";
import { createSpeechService } from "./speech-runtime.js";

const { initializeLocalSpeechServicesMock } = vi.hoisted(() => ({
  initializeLocalSpeechServicesMock: vi.fn<(args: unknown) => Promise<InitializedLocalSpeech>>(),
}));

vi.mock("./providers/local/runtime.js", () => ({
  initializeLocalSpeechServices: initializeLocalSpeechServicesMock,
}));

vi.mock("./providers/openai/runtime.js", () => ({
  getOpenAiSpeechAvailability: () => ({ configured: false }),
  initializeOpenAiSpeechServices: (args: {
    existing: {
      turnDetectionService: TurnDetectionProvider | null;
      sttService: SpeechToTextProvider | null;
      ttsService: TextToSpeechProvider | null;
      dictationSttService: SpeechToTextProvider | null;
    };
  }) => ({
    turnDetectionService: args.existing.turnDetectionService,
    sttService: args.existing.sttService,
    ttsService: args.existing.ttsService,
    dictationSttService: args.existing.dictationSttService,
  }),
  validateOpenAiCredentialRequirements: () => {},
}));

vi.mock("./providers/local/models.js", () => ({
  ensureLocalSpeechModels: vi.fn(async () => {}),
  getLocalSpeechModelDir: vi.fn(() => ""),
  listLocalSpeechModels: vi.fn(() => []),
}));

vi.mock("./providers/local/runtime/index.js", () => ({
  clearLocalSpeechRuntimeHome: vi.fn(),
  configureLocalSpeechRuntimeHome: vi.fn(),
  ensureLocalSpeechRuntime: vi.fn(async () => ({
    runtimeDir: "/tmp/paseo/runtime/local-speech",
    missingPackageIds: [],
  })),
  getLocalSpeechRuntimeStatus: vi.fn(async () => ({
    runtimeDir: "/tmp/paseo/runtime/local-speech",
    missingPackageIds: [],
  })),
}));

function createStubStt(id: string): SpeechToTextProvider {
  return {
    id,
    createSession: vi.fn(() => {
      throw new Error("not used in this test");
    }),
  };
}

function createStubTts(id: string): TextToSpeechProvider {
  return {
    id,
    synthesizeSpeech: vi.fn(async () => {
      throw new Error("not used in this test");
    }),
  };
}

function createStubTurnDetection(id: string): TurnDetectionProvider {
  return {
    id,
    createSession: vi.fn(() => {
      throw new Error("not used in this test");
    }),
  };
}

function createSpeechConfig(providers: PaseoSpeechConfig["providers"]): PaseoSpeechConfig {
  return {
    providers,
    sttLanguages: {
      dictation: "en",
      voice: "en",
    },
  };
}

describe("createSpeechService readiness", () => {
  beforeEach(() => {
    initializeLocalSpeechServicesMock.mockReset();
  });

  it("keeps voice feature available when only dictation is enabled and ready", async () => {
    const dictationStt = createStubStt("dictation-local");

    initializeLocalSpeechServicesMock.mockResolvedValue({
      turnDetectionService: null,
      sttService: null,
      ttsService: null,
      dictationSttService: dictationStt,
      localVoiceTtsProvider: null,
      localModelConfig: null,
      availability: {
        configured: false,
        modelsDir: null,
      },
      cleanup: () => {},
    });

    const runtime = createSpeechService({
      logger: pino({ level: "silent" }),
      paseoHome: "/tmp/paseo",
      speechConfig: createSpeechConfig({
        dictationStt: { provider: "local", enabled: true, explicit: true },
        voiceTurnDetection: { provider: "local", enabled: false, explicit: true },
        voiceStt: { provider: "local", enabled: false, explicit: true },
        voiceTts: { provider: "local", enabled: false, explicit: true },
      }),
    });
    runtime.start();
    await runtime.ready;

    const readiness = runtime.getReadiness();
    expect(readiness.dictation.available).toBe(true);
    expect(readiness.realtimeVoice.reasonCode).toBe("disabled");
    expect(readiness.voiceFeature.available).toBe(true);
    expect(readiness.voiceFeature.reasonCode).toBe("ready");

    runtime.stop();
  });

  it("keeps voice feature available when only realtime voice is enabled and ready", async () => {
    const voiceStt = createStubStt("voice-local");
    const voiceTts = createStubTts("tts-local");
    const turnDetection = createStubTurnDetection("turn-local");

    initializeLocalSpeechServicesMock.mockResolvedValue({
      turnDetectionService: turnDetection,
      sttService: voiceStt,
      ttsService: voiceTts,
      dictationSttService: null,
      localVoiceTtsProvider: voiceTts,
      localModelConfig: null,
      availability: {
        configured: false,
        modelsDir: null,
      },
      cleanup: () => {},
    });

    const runtime = createSpeechService({
      logger: pino({ level: "silent" }),
      paseoHome: "/tmp/paseo",
      speechConfig: createSpeechConfig({
        dictationStt: { provider: "local", enabled: false, explicit: true },
        voiceTurnDetection: { provider: "local", enabled: true, explicit: true },
        voiceStt: { provider: "local", enabled: true, explicit: true },
        voiceTts: { provider: "local", enabled: true, explicit: true },
      }),
    });
    runtime.start();
    await runtime.ready;

    const readiness = runtime.getReadiness();
    expect(readiness.realtimeVoice.available).toBe(true);
    expect(readiness.dictation.reasonCode).toBe("disabled");
    expect(readiness.voiceFeature.available).toBe(true);
    expect(readiness.voiceFeature.reasonCode).toBe("ready");

    runtime.stop();
  });
});
