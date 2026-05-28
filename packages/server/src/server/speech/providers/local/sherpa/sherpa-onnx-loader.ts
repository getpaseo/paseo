import { loadLocalSpeechPackage } from "../runtime/index.js";

export interface SherpaOnnxModule {
  createOnlineRecognizer: (config: unknown) => unknown;
  createOfflineRecognizer: (config: unknown) => unknown;
  createOfflineTts: (config: unknown) => unknown;
}

let cached: SherpaOnnxModule | null = null;

export function loadSherpaOnnx(): SherpaOnnxModule {
  if (cached) {
    return cached;
  }

  cached = loadLocalSpeechPackage<SherpaOnnxModule>("sherpa-onnx", {
    requireFrom: import.meta.url,
  });
  return cached;
}
