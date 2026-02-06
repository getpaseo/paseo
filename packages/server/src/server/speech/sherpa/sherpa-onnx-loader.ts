import { createRequire } from "node:module";

export type SherpaOnnxModule = {
  createOnlineRecognizer: (config: any) => any;
  createOfflineRecognizer: (config: any) => any;
  createOfflineTts: (config: any) => any;
};

let cached: SherpaOnnxModule | null = null;

export function loadSherpaOnnx(): SherpaOnnxModule {
  if (cached) {
    return cached;
  }
  const require = createRequire(import.meta.url);
  cached = require("sherpa-onnx") as SherpaOnnxModule;
  return cached;
}
