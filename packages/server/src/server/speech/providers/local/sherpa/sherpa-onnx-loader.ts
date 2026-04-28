import { createRequire } from "node:module";

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

  const require = createRequire(import.meta.url);
  cached = require("sherpa-onnx") as SherpaOnnxModule;
  return cached;
}
