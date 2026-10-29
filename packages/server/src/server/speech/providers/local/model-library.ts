import type { Logger } from "pino";

import {
  deleteSherpaOnnxModel,
  ensureSherpaOnnxModel,
  isSherpaOnnxModelInstalled,
} from "./sherpa/model-downloader.js";
import {
  listLocalSpeechModels,
  type LocalSpeechModelId,
  type LocalSpeechModelSpec,
} from "./models.js";

export type LocalSpeechModelInstallState =
  | { status: "installed" }
  | { status: "not_installed" }
  | { status: "downloading"; receivedBytes: number; totalBytes: number }
  | { status: "extracting" }
  | { status: "failed"; error: string };

export interface LocalSpeechModelEntry {
  spec: LocalSpeechModelSpec;
  state: LocalSpeechModelInstallState;
}

type InFlightState = Extract<
  LocalSpeechModelInstallState,
  { status: "downloading" | "extracting" }
>;

interface InFlightDownload {
  promise: Promise<string>;
  state: InFlightState;
}

export class LocalSpeechModelBusyError extends Error {
  constructor(public readonly modelId: LocalSpeechModelId) {
    super(`${modelId} is downloading. Wait for the download to finish before deleting it.`);
    this.name = "LocalSpeechModelBusyError";
  }
}

// Owns the models directory: which catalog models are installed, which are downloading,
// and the last failure per model. Concurrent downloads of one model share a single transfer.
export class LocalSpeechModelLibrary {
  private readonly inFlight = new Map<LocalSpeechModelId, InFlightDownload>();
  private readonly failures = new Map<LocalSpeechModelId, string>();
  private readonly abortController = new AbortController();
  private readonly logger: Logger;

  constructor(
    private readonly modelsDir: string,
    logger: Logger,
  ) {
    this.logger = logger.child({ module: "speech", component: "local-model-library" });
  }

  getModelsDir(): string {
    return this.modelsDir;
  }

  async list(): Promise<LocalSpeechModelEntry[]> {
    return Promise.all(
      listLocalSpeechModels().map(async (spec) => ({ spec, state: await this.getState(spec.id) })),
    );
  }

  async listMissing(modelIds: LocalSpeechModelId[]): Promise<LocalSpeechModelId[]> {
    const installed = await Promise.all(
      modelIds.map((modelId) => isSherpaOnnxModelInstalled(this.modelsDir, modelId)),
    );
    return modelIds.filter((_modelId, index) => !installed[index]);
  }

  download(modelId: LocalSpeechModelId): Promise<string> {
    const existing = this.inFlight.get(modelId);
    if (existing) {
      return existing.promise;
    }
    this.failures.delete(modelId);
    const entry: InFlightDownload = {
      state: { status: "downloading", receivedBytes: 0, totalBytes: 0 },
      promise: Promise.resolve(""),
    };
    entry.promise = ensureSherpaOnnxModel({
      modelsDir: this.modelsDir,
      modelId,
      logger: this.logger,
      signal: this.abortController.signal,
      onProgress: (progress) => {
        entry.state =
          progress.phase === "downloading"
            ? {
                status: "downloading",
                receivedBytes: progress.receivedBytes,
                totalBytes: progress.totalBytes,
              }
            : { status: "extracting" };
      },
    })
      .catch((error: unknown) => {
        this.failures.set(modelId, error instanceof Error ? error.message : String(error));
        throw error;
      })
      .finally(() => {
        this.inFlight.delete(modelId);
      });
    this.inFlight.set(modelId, entry);
    return entry.promise;
  }

  async delete(modelId: LocalSpeechModelId): Promise<void> {
    if (this.inFlight.has(modelId)) {
      throw new LocalSpeechModelBusyError(modelId);
    }
    this.failures.delete(modelId);
    await deleteSherpaOnnxModel(this.modelsDir, modelId);
    this.logger.info({ modelId }, "Deleted local speech model");
  }

  async stop(): Promise<void> {
    this.abortController.abort();
    await Promise.allSettled(Array.from(this.inFlight.values(), (entry) => entry.promise));
  }

  private async getState(modelId: LocalSpeechModelId): Promise<LocalSpeechModelInstallState> {
    const inFlight = this.inFlight.get(modelId);
    if (inFlight) {
      return inFlight.state;
    }
    if (await isSherpaOnnxModelInstalled(this.modelsDir, modelId)) {
      return { status: "installed" };
    }
    const failure = this.failures.get(modelId);
    return failure ? { status: "failed", error: failure } : { status: "not_installed" };
  }
}
