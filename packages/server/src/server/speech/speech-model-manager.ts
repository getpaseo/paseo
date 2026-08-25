import { rm } from "node:fs/promises";
import path from "node:path";
import type pino from "pino";
import type { SpeechModelItem, SpeechModelPreferences } from "@getpaseo/protocol/messages";
import {
  loadPersistedConfig,
  savePersistedConfig,
  type PersistedConfig,
} from "../persisted-config.js";
import {
  DEFAULT_LOCAL_STT_MODEL,
  DEFAULT_LOCAL_TTS_MODEL,
  SHERPA_ONNX_MODEL_CATALOG,
  type SherpaOnnxCatalogEntry,
  type SherpaOnnxModelId,
} from "./providers/local/sherpa/model-catalog.js";
import {
  ensureSherpaOnnxModel,
  hasRequiredFiles,
  type SherpaOnnxDownloadProgress,
} from "./providers/local/sherpa/model-downloader.js";

const SPEECH_MODEL_KIND_MAP: Record<string, "stt" | "tts" | "vad"> = {
  "stt-offline": "stt",
  tts: "tts",
  vad: "vad",
};

export class SpeechModelManager {
  private activeDownloads = new Set<string>();

  constructor(
    private readonly modelsDir: string,
    private readonly logger: pino.Logger,
    private readonly paseoHome?: string,
  ) {}

  getModelsDir(): string {
    return this.modelsDir;
  }

  private requirePaseoHome(): string {
    if (!this.paseoHome) {
      throw new Error("Paseo home is unavailable for speech model preferences");
    }
    return this.paseoHome;
  }

  getPreferences(): SpeechModelPreferences {
    const persisted = loadPersistedConfig(this.requirePaseoHome(), this.logger);
    const sttModel = persisted.features?.dictation?.stt?.model;
    const ttsModel = persisted.features?.voiceMode?.tts?.model;
    const language = persisted.features?.dictation?.stt?.language;
    const ttsSpeakerId = persisted.features?.voiceMode?.tts?.speakerId;

    const activeSttModelId =
      sttModel && sttModel in SHERPA_ONNX_MODEL_CATALOG ? sttModel : DEFAULT_LOCAL_STT_MODEL;
    const activeTtsModelId =
      ttsModel && ttsModel in SHERPA_ONNX_MODEL_CATALOG ? ttsModel : DEFAULT_LOCAL_TTS_MODEL;

    return {
      activeSttModelId,
      activeTtsModelId,
      modelLanguages:
        language && activeSttModelId
          ? { [activeSttModelId]: language }
          : {},
      ttsSpeakerId: typeof ttsSpeakerId === "number" ? ttsSpeakerId : null,
      dictationEnabled: persisted.features?.dictation?.enabled !== false,
      voiceModeEnabled: persisted.features?.voiceMode?.enabled !== false,
    };
  }

  private writeFeatureModels(next: {
    dictationSttModel?: string;
    voiceSttModel?: string;
    voiceTtsModel?: string;
    sttLanguage?: string;
    voiceTtsSpeakerId?: number;
    dictationEnabled?: boolean;
    voiceModeEnabled?: boolean;
  }): void {
    const persisted = loadPersistedConfig(this.requirePaseoHome(), this.logger);
    const features = persisted.features ?? {};
    const dictation = features.dictation ?? {};
    const voiceMode = features.voiceMode ?? {};
    const dictationStt = { ...dictation.stt };
    const voiceStt = { ...voiceMode.stt };
    const voiceTts = { ...voiceMode.tts };

    if (next.dictationSttModel !== undefined) {
      dictationStt.model = next.dictationSttModel;
    }
    if (next.voiceSttModel !== undefined) {
      voiceStt.model = next.voiceSttModel;
    }
    if (next.voiceTtsModel !== undefined) {
      voiceTts.model = next.voiceTtsModel;
    }
    if (next.voiceTtsSpeakerId !== undefined) {
      voiceTts.speakerId = next.voiceTtsSpeakerId;
    }
    if (next.sttLanguage !== undefined) {
      dictationStt.language = next.sttLanguage;
      voiceStt.language = next.sttLanguage;
    }

    const nextFeatures: PersistedConfig["features"] = {
      ...features,
      dictation: {
        ...dictation,
        stt: dictationStt,
        ...(next.dictationEnabled !== undefined ? { enabled: next.dictationEnabled } : {}),
      },
      voiceMode: {
        ...voiceMode,
        stt: voiceStt,
        tts: voiceTts,
        ...(next.voiceModeEnabled !== undefined ? { enabled: next.voiceModeEnabled } : {}),
      },
    };

    savePersistedConfig(
      this.requirePaseoHome(),
      { ...persisted, features: nextFeatures },
      this.logger,
    );
  }

  setFeatureEnabled(feature: "dictation" | "voiceMode", enabled: boolean): void {
    if (feature === "dictation") {
      this.writeFeatureModels({ dictationEnabled: enabled });
      return;
    }
    this.writeFeatureModels({ voiceModeEnabled: enabled });
  }

  async setActiveModel(modelId: string): Promise<void> {
    const spec = SHERPA_ONNX_MODEL_CATALOG[modelId as SherpaOnnxModelId];
    if (!spec) {
      throw new Error(`Unknown speech model ID: ${modelId}`);
    }
    if (spec.runtimeSupported !== true) {
      throw new Error(`Model "${spec.displayName}" does not support runtime execution yet`);
    }
    if (
      spec.archiveUrl &&
      !(await hasRequiredFiles(path.join(this.modelsDir, spec.extractedDir), spec.requiredFiles))
    ) {
      throw new Error(`Download model "${spec.displayName}" before activating it`);
    }

    if (spec.kind === "stt-offline") {
      this.writeFeatureModels({
        dictationSttModel: spec.id,
        voiceSttModel: spec.id,
      });
      return;
    }
    if (spec.kind === "tts") {
      this.writeFeatureModels({ voiceTtsModel: spec.id });
      return;
    }
    throw new Error(`Cannot activate model "${spec.displayName}" (kind: ${spec.kind})`);
  }

  setModelLanguage(modelId: string, language: string): void {
    const spec = SHERPA_ONNX_MODEL_CATALOG[modelId as SherpaOnnxModelId];
    if (!spec) {
      throw new Error(`Unknown speech model ID: ${modelId}`);
    }
    const trimmed = language.trim();
    if (!trimmed) {
      throw new Error(`Language must not be empty`);
    }

    if (spec.kind === "stt-offline") {
      this.writeFeatureModels({ sttLanguage: trimmed });
      return;
    }
    if (spec.kind === "tts") {
      // For TTS, the language is selected via the speaker voice: pick the
      // first official voice for the requested language.
      const voice = spec.voices?.find(
        (entry) => entry.language.toLowerCase() === trimmed.toLowerCase(),
      );
      if (!voice) {
        throw new Error(`Language "${trimmed}" is not supported by "${spec.displayName}"`);
      }
      this.writeFeatureModels({ voiceTtsSpeakerId: voice.id });
      return;
    }
    throw new Error(`Language selection is only supported for STT and TTS models`);
  }

  setSpeaker(modelId: string, speakerId: number): void {
    const spec = SHERPA_ONNX_MODEL_CATALOG[modelId as SherpaOnnxModelId];
    if (!spec) {
      throw new Error(`Unknown speech model ID: ${modelId}`);
    }
    if (spec.kind !== "tts") {
      throw new Error(`Speaker selection is only supported for TTS models`);
    }
    const voice = spec.voices?.find((entry) => entry.id === speakerId);
    if (!voice) {
      throw new Error(`Speaker ${speakerId} is not available for "${spec.displayName}"`);
    }
    this.writeFeatureModels({ voiceTtsSpeakerId: voice.id });
  }

  async listModels(): Promise<SpeechModelItem[]> {
    const entries = Object.entries(SHERPA_ONNX_MODEL_CATALOG) as [
      SherpaOnnxModelId,
      SherpaOnnxCatalogEntry,
    ][];
    const items: SpeechModelItem[] = [];

    for (const [id, spec] of entries) {
      const modelDir = path.join(this.modelsDir, spec.extractedDir);
      let isInstalled = false;

      if (!spec.archiveUrl) {
        isInstalled = true;
      } else {
        isInstalled = await hasRequiredFiles(modelDir, spec.requiredFiles);
      }

      const isDownloading = this.activeDownloads.has(id);
      const status = isDownloading
        ? "downloading"
        : isInstalled
          ? "installed"
          : "not_installed";

      items.push({
        id,
        name: spec.displayName,
        kind: SPEECH_MODEL_KIND_MAP[spec.kind] ?? "stt",
        description: spec.description,
        languages: [...spec.languages],
        sizeMB: spec.sizeMB,
        status,
        isDefault: Boolean(spec.defaultFor),
        runtimeSupported: Boolean(spec.runtimeSupported),
        sha256: spec.sha256,
        storagePath: isInstalled ? modelDir : undefined,
        voices: spec.voices?.map((voice) => ({ ...voice })),
      });
    }

    return items;
  }

  async downloadModel(
    modelId: string,
    options?: {
      signal?: AbortSignal;
      onProgress?: (progress: SherpaOnnxDownloadProgress & { modelId: string }) => void;
    },
  ): Promise<void> {
    if (!(modelId in SHERPA_ONNX_MODEL_CATALOG)) {
      throw new Error(`Unknown speech model ID: ${modelId}`);
    }

    if (this.activeDownloads.has(modelId)) {
      throw new Error(`Model ${modelId} is already downloading`);
    }

    this.activeDownloads.add(modelId);
    try {
      await ensureSherpaOnnxModel({
        modelsDir: this.modelsDir,
        modelId: modelId as SherpaOnnxModelId,
        logger: this.logger,
        signal: options?.signal,
        onProgress: options?.onProgress
          ? (progress) => options.onProgress?.({ ...progress, modelId })
          : undefined,
      });
    } finally {
      this.activeDownloads.delete(modelId);
    }
  }

  async deleteModel(modelId: string): Promise<void> {
    if (!(modelId in SHERPA_ONNX_MODEL_CATALOG)) {
      throw new Error(`Unknown speech model ID: ${modelId}`);
    }

    const spec = SHERPA_ONNX_MODEL_CATALOG[modelId as SherpaOnnxModelId];
    if (!spec.archiveUrl) {
      throw new Error(`Cannot delete bundled model: ${modelId}`);
    }

    const modelDir = path.join(this.modelsDir, spec.extractedDir);
    await rm(modelDir, { recursive: true, force: true });
  }
}
