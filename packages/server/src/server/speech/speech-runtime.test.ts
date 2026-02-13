import { beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";

import type { PaseoSpeechConfig } from "../bootstrap.js";
import type { InitializedLocalSpeech } from "./providers/local/runtime.js";
import type { SpeechToTextProvider, TextToSpeechProvider } from "./speech-provider.js";
import { initializeSpeechRuntime } from "./speech-runtime.js";

const { initializeLocalSpeechServicesMock } = vi.hoisted(() => ({
  initializeLocalSpeechServicesMock: vi.fn<
    (args: unknown) => Promise<InitializedLocalSpeech>
  >(),
}));

vi.mock("./providers/local/runtime.js", () => ({
  initializeLocalSpeechServices: initializeLocalSpeechServicesMock,
}));

vi.mock("./providers/openai/runtime.js", () => ({
  getOpenAiSpeechAvailability: () => ({ configured: false }),
  initializeOpenAiSpeechServices: (args: {
    existing: {
      sttService: SpeechToTextProvider | null;
      ttsService: TextToSpeechProvider | null;
      dictationSttService: SpeechToTextProvider | null;
    };
  }) => ({
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

function createSpeechConfig(
  providers: PaseoSpeechConfig["providers"]
): PaseoSpeechConfig {
  return { providers };
}

describe("initializeSpeechRuntime readiness", () => {
  beforeEach(() => {
    initializeLocalSpeechServicesMock.mockReset();
  });

  it("keeps voice feature available when only dictation is enabled and ready", async () => {
    const dictationStt = createStubStt("dictation-local");

    initializeLocalSpeechServicesMock.mockResolvedValue({
      sttService: null,
      ttsService: null,
      dictationSttService: dictationStt,
      localVoiceTtsProvider: null,
      localModelConfig: null,
      availability: {
        configured: false,
        modelsDir: null,
        autoDownload: null,
      },
      cleanup: () => {},
    });

    const runtime = await initializeSpeechRuntime({
      logger: pino({ level: "silent" }),
      speechConfig: createSpeechConfig({
        dictationStt: { provider: "local", enabled: true, explicit: true },
        voiceStt: { provider: "local", enabled: false, explicit: true },
        voiceTts: { provider: "local", enabled: false, explicit: true },
      }),
    });

    const readiness = runtime.getSpeechReadiness();
    expect(readiness.dictation.available).toBe(true);
    expect(readiness.realtimeVoice.reasonCode).toBe("disabled");
    expect(readiness.voiceFeature.available).toBe(true);
    expect(readiness.voiceFeature.reasonCode).toBe("ready");

    runtime.cleanup();
  });

  it("keeps voice feature available when only realtime voice is enabled and ready", async () => {
    const voiceStt = createStubStt("voice-local");
    const voiceTts = createStubTts("tts-local");

    initializeLocalSpeechServicesMock.mockResolvedValue({
      sttService: voiceStt,
      ttsService: voiceTts,
      dictationSttService: null,
      localVoiceTtsProvider: voiceTts,
      localModelConfig: null,
      availability: {
        configured: false,
        modelsDir: null,
        autoDownload: null,
      },
      cleanup: () => {},
    });

    const runtime = await initializeSpeechRuntime({
      logger: pino({ level: "silent" }),
      speechConfig: createSpeechConfig({
        dictationStt: { provider: "local", enabled: false, explicit: true },
        voiceStt: { provider: "local", enabled: true, explicit: true },
        voiceTts: { provider: "local", enabled: true, explicit: true },
      }),
    });

    const readiness = runtime.getSpeechReadiness();
    expect(readiness.realtimeVoice.available).toBe(true);
    expect(readiness.dictation.reasonCode).toBe("disabled");
    expect(readiness.voiceFeature.available).toBe(true);
    expect(readiness.voiceFeature.reasonCode).toBe("ready");

    runtime.cleanup();
  });
});
