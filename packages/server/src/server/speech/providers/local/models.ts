import {
  ensureSherpaOnnxModels,
  getSherpaOnnxModelDir,
  isSherpaOnnxModelInstalled,
} from "./sherpa/model-downloader.js";
import {
  DEFAULT_LOCAL_STT_MODEL,
  DEFAULT_LOCAL_TTS_MODEL,
  LocalSttModelIdSchema,
  LocalTtsModelIdSchema,
  listSherpaOnnxModels,
  type LocalSpeechModelId,
  type LocalSttModelId,
  type LocalTtsModelId,
} from "./sherpa/model-catalog.js";

export {
  DEFAULT_LOCAL_STT_MODEL,
  DEFAULT_LOCAL_TTS_MODEL,
  LocalSttModelIdSchema,
  LocalTtsModelIdSchema,
  type LocalSpeechModelId,
  type LocalSttModelId,
  type LocalTtsModelId,
};

export type LocalSpeechModelSpec = ReturnType<typeof listSherpaOnnxModels>[number];

export function listLocalSpeechModels(): LocalSpeechModelSpec[] {
  return listSherpaOnnxModels();
}

export function getLocalSpeechModelDir(modelsDir: string, modelId: LocalSpeechModelId): string {
  return getSherpaOnnxModelDir(modelsDir, modelId);
}

export async function listMissingLocalSpeechModels(options: {
  modelsDir: string;
  modelIds: LocalSpeechModelId[];
}): Promise<LocalSpeechModelId[]> {
  const installed = await Promise.all(
    options.modelIds.map((modelId) => isSherpaOnnxModelInstalled(options.modelsDir, modelId)),
  );
  return options.modelIds.filter((_modelId, index) => !installed[index]);
}

export async function ensureLocalSpeechModels(options: {
  modelsDir: string;
  modelIds: LocalSpeechModelId[];
  logger: import("pino").Logger;
  signal?: AbortSignal;
}): Promise<Record<LocalSpeechModelId, string>> {
  return ensureSherpaOnnxModels({
    modelsDir: options.modelsDir,
    modelIds: options.modelIds,
    logger: options.logger,
    signal: options.signal,
  });
}
