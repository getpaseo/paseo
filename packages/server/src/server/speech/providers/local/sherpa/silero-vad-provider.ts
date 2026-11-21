import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "pino";

import type {
  TurnDetectionProvider,
  TurnDetectionSession,
} from "../../../turn-detection-provider.js";
import {
  resolveBundledSileroVadModelPath,
  SherpaSileroVadSession,
  type SherpaSileroVadSessionConfig,
} from "./silero-vad-session.js";

const SILERO_VAD_DIR = "silero-vad";
const SILERO_VAD_FILE = "silero_vad.onnx";

/**
 * Ensure the Silero VAD ONNX model exists in modelsDir where native code can
 * read it. The bundled asset lives inside Electron's app.asar which native C++
 * cannot open, so we copy it out on first run using Node.js fs (asar-aware).
 */
export async function ensureSileroVadModel(modelsDir: string, logger: Logger): Promise<string> {
  const destDir = path.join(modelsDir, SILERO_VAD_DIR);
  const destPath = path.join(destDir, SILERO_VAD_FILE);

  try {
    const s = await stat(destPath);
    if (s.isFile() && s.size > 0) return destPath;
  } catch {
    // not present yet
  }

  const bundledPath = resolveBundledSileroVadModelPath();
  await mkdir(destDir, { recursive: true });
  await copyFile(bundledPath, destPath);
  logger.info({ destPath }, "Copied Silero VAD model to models directory");
  return destPath;
}

export class SherpaSileroTurnDetectionProvider implements TurnDetectionProvider {
  public readonly id = "local" as const;

  private readonly config: SherpaSileroVadSessionConfig;
  private readonly logger: Logger;

  constructor(config: SherpaSileroVadSessionConfig, logger: Logger) {
    this.config = config;
    this.logger = logger.child({
      module: "speech",
      provider: "local",
      component: "silero-vad",
    });
  }

  createSession(params: { logger: Logger; confirmMs?: number }): TurnDetectionSession {
    this.logger.debug(
      { sampleRate: this.config.sampleRate, modelPath: this.config.modelPath },
      "Creating Silero VAD turn-detection session",
    );
    return new SherpaSileroVadSession({
      logger: params.logger.child({
        provider: "local",
        component: "silero-vad-session",
      }),
      config:
        params.confirmMs === undefined
          ? this.config
          : { ...this.config, confirmMs: params.confirmMs },
    });
  }
}
