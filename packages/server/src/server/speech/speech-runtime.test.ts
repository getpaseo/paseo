import { beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";

import type { PaseoSpeechConfig } from "../bootstrap.js";
import type { LocalSpeechModelId } from "./providers/local/models.js";
import type { InitializedLocalSpeech } from "./providers/local/runtime.js";
import type { SpeechToTextProvider, TextToSpeechProvider } from "./speech-provider.js";
import type { TurnDetectionProvider } from "./turn-detection-provider.js";
import { createSpeechService, LocalSpeechModelInUseError } from "./speech-runtime.js";

const { ensureSherpaOnnxModelMock, initializeLocalSpeechServicesMock } = vi.hoisted(() => ({
  ensureSherpaOnnxModelMock: vi.fn(async (_options: { signal?: AbortSignal }) => ""),
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

vi.mock("./providers/local/sherpa/model-downloader.js", () => ({
  ensureSherpaOnnxModel: ensureSherpaOnnxModelMock,
  isSherpaOnnxModelInstalled: vi.fn(async () => false),
  deleteSherpaOnnxModel: vi.fn(async () => {}),
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

function rejectWhenAborted(signal?: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function createSpeechConfig(providers: PaseoSpeechConfig["providers"]): PaseoSpeechConfig {
  return {
    providers,
    localModelsDir: "/tmp/missing-local-speech-models",
    sttLanguages: {
      dictation: "en",
      voice: "en",
    },
  };
}

describe("createSpeechService readiness", () => {
  beforeEach(() => {
    ensureSherpaOnnxModelMock.mockReset();
    ensureSherpaOnnxModelMock.mockResolvedValue("");
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

    await runtime.stop();
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

    await runtime.stop();
  });

  it("aborts and joins an in-flight model download when stopped", async () => {
    let downloadSignal: AbortSignal | undefined;
    ensureSherpaOnnxModelMock.mockImplementation(({ signal }: { signal?: AbortSignal }) => {
      downloadSignal = signal;
      return rejectWhenAborted(signal);
    });
    initializeLocalSpeechServicesMock.mockResolvedValue({
      turnDetectionService: null,
      sttService: null,
      ttsService: null,
      dictationSttService: null,
      localVoiceTtsProvider: null,
      localModelConfig: {
        modelsDir: "/tmp/missing-local-speech-models",
        defaultModelIds: ["parakeet-tdt-0.6b-v2-int8"],
      },
      availability: {
        configured: true,
        modelsDir: "/tmp/missing-local-speech-models",
      },
      cleanup: () => {},
    });

    const runtime = createSpeechService({
      logger: pino({ level: "silent" }),
      speechConfig: createSpeechConfig({
        dictationStt: { provider: "local", enabled: true, explicit: true },
        voiceTurnDetection: { provider: "local", enabled: false, explicit: true },
        voiceStt: { provider: "local", enabled: false, explicit: true },
        voiceTts: { provider: "local", enabled: false, explicit: true },
      }),
    });
    runtime.start();
    await runtime.ready;
    expect(ensureSherpaOnnxModelMock).toHaveBeenCalledOnce();

    await runtime.stop();

    expect(downloadSignal?.aborted).toBe(true);
  });
});

describe("createSpeechService settings changes", () => {
  const dictationOnly = createSpeechConfig({
    dictationStt: { provider: "local", enabled: true, explicit: true },
    voiceTurnDetection: { provider: "local", enabled: false, explicit: true },
    voiceStt: { provider: "local", enabled: false, explicit: true },
    voiceTts: { provider: "local", enabled: false, explicit: true },
  });
  const nothingEnabled = createSpeechConfig({
    dictationStt: { provider: "local", enabled: false, explicit: true },
    voiceTurnDetection: { provider: "local", enabled: false, explicit: true },
    voiceStt: { provider: "local", enabled: false, explicit: true },
    voiceTts: { provider: "local", enabled: false, explicit: true },
  });

  function localSpeech(input: {
    dictationStt: SpeechToTextProvider | null;
    defaultModelIds: LocalSpeechModelId[];
  }): InitializedLocalSpeech {
    return {
      turnDetectionService: null,
      sttService: null,
      ttsService: null,
      dictationSttService: input.dictationStt,
      localVoiceTtsProvider: null,
      localModelConfig: {
        modelsDir: "/tmp/missing-local-speech-models",
        defaultModelIds: input.defaultModelIds,
      },
      availability: { configured: true, modelsDir: "/tmp/missing-local-speech-models" },
      cleanup: () => {},
    };
  }

  beforeEach(() => {
    ensureSherpaOnnxModelMock.mockReset();
    ensureSherpaOnnxModelMock.mockResolvedValue("");
    initializeLocalSpeechServicesMock.mockReset();
  });

  it("applies new providers without a restart", async () => {
    initializeLocalSpeechServicesMock.mockResolvedValue(
      localSpeech({ dictationStt: createStubStt("dictation-local"), defaultModelIds: [] }),
    );
    const runtime = createSpeechService({
      logger: pino({ level: "silent" }),
      speechConfig: dictationOnly,
    });
    runtime.start();
    await runtime.ready;
    expect(runtime.getReadiness().dictation.available).toBe(true);

    const disabled = new Promise<void>((resolve) => {
      runtime.onReadinessChange((snapshot) => {
        if (snapshot.dictation.reasonCode === "disabled") resolve();
      });
    });
    initializeLocalSpeechServicesMock.mockResolvedValue(
      localSpeech({ dictationStt: null, defaultModelIds: [] }),
    );
    runtime.reconfigure({ speechConfig: nothingEnabled });
    await disabled;

    expect(runtime.resolveDictationStt()).toBeNull();
    await runtime.stop();
  });

  it("refuses to delete a model an enabled feature uses", async () => {
    initializeLocalSpeechServicesMock.mockResolvedValue(
      localSpeech({
        dictationStt: createStubStt("dictation-local"),
        defaultModelIds: ["parakeet-tdt-0.6b-v2-int8"],
      }),
    );
    ensureSherpaOnnxModelMock.mockImplementation(({ signal }) => rejectWhenAborted(signal));
    const runtime = createSpeechService({
      logger: pino({ level: "silent" }),
      speechConfig: dictationOnly,
    });
    runtime.start();
    await runtime.ready;

    const models = await runtime.listLocalModels();
    expect(models.filter((model) => model.inUse).map((model) => model.spec.id)).toEqual([
      "parakeet-tdt-0.6b-v2-int8",
    ]);
    await expect(runtime.deleteLocalModel("parakeet-tdt-0.6b-v2-int8")).rejects.toBeInstanceOf(
      LocalSpeechModelInUseError,
    );
    await expect(runtime.deleteLocalModel("kokoro-int8-en-v0_19")).resolves.toBeUndefined();

    await runtime.stop();
  });
});
