import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export function resolveDefaultSpeechModelsDir(paseoHome: string): string {
  if (process.env.PASEO_LOCAL_MODELS_DIR) {
    return process.env.PASEO_LOCAL_MODELS_DIR;
  }

  const userHomeModels = path.join(homedir(), ".paseo", "models", "local-speech");
  if (existsSync(userHomeModels)) {
    return userHomeModels;
  }

  const localHomeModels = path.join(paseoHome, "models", "local-speech");
  if (existsSync(localHomeModels)) {
    return localHomeModels;
  }

  return userHomeModels;
}
