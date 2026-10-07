import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type pino from "pino";

import { getSherpaOnnxModelSpec, type SherpaOnnxModelId } from "./model-catalog.js";
import { spawnProcess } from "../../../../../utils/spawn.js";

export interface EnsureSherpaOnnxModelOptions {
  modelsDir: string;
  modelId: SherpaOnnxModelId;
  logger: pino.Logger;
  signal?: AbortSignal;
}

export function getSherpaOnnxModelDir(modelsDir: string, modelId: SherpaOnnxModelId): string {
  const spec = getSherpaOnnxModelSpec(modelId);
  return path.join(modelsDir, spec.extractedDir);
}

async function hasRequiredFiles(modelDir: string, requiredFiles: string[]): Promise<boolean> {
  const results = await Promise.all(
    requiredFiles.map(async (rel) => {
      const abs = path.join(modelDir, rel);
      try {
        const s = await stat(abs);
        if (s.isDirectory()) {
          return true;
        }
        return s.isFile() && s.size > 0;
      } catch {
        return false;
      }
    }),
  );
  return results.every((present) => present);
}

interface DownloadToFileOptions {
  url: string;
  outputPath: string;
  signal?: AbortSignal;
}

async function downloadToFile(options: DownloadToFileOptions): Promise<void> {
  const { url, outputPath } = options;
  const res = await fetch(url, { signal: options.signal });
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
  }
  if (!res.body) {
    throw new Error(`Failed to download ${url}: missing response body`);
  }

  const tmpPath = `${outputPath}.tmp-${Date.now()}`;
  await mkdir(path.dirname(outputPath), { recursive: true });

  // The fetch ReadableStream type is slightly different from what Readable.fromWeb expects
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodeStream = Readable.fromWeb(res.body as any);

  try {
    await pipeline(nodeStream, createWriteStream(tmpPath), { signal: options.signal });
    await rename(tmpPath, outputPath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function extractTarArchive(
  archivePath: string,
  destDir: string,
  signal?: AbortSignal,
): Promise<void> {
  await mkdir(destDir, { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const child = spawnProcess("tar", ["xf", archivePath, "-C", destDir], {
      stdio: "inherit",
      signal,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited with code ${code}`));
    });
  });
}

interface SherpaOnnxModelPaths {
  modelDir: string;
  archivePath: string;
  extractionDir: string;
}

function getSherpaOnnxModelPaths(
  modelsDir: string,
  modelId: SherpaOnnxModelId,
): SherpaOnnxModelPaths {
  const spec = getSherpaOnnxModelSpec(modelId);
  const downloadsDir = path.join(modelsDir, ".downloads");
  return {
    modelDir: path.join(modelsDir, spec.extractedDir),
    archivePath: path.join(downloadsDir, path.basename(new URL(spec.archiveUrl).pathname)),
    extractionDir: path.join(downloadsDir, `${spec.extractedDir}.extracting`),
  };
}

// The archive is removed only as its model moves into place, so a model whose archive is
// still in .downloads did not finish installing and may hold truncated files.
export async function isSherpaOnnxModelInstalled(
  modelsDir: string,
  modelId: SherpaOnnxModelId,
): Promise<boolean> {
  const spec = getSherpaOnnxModelSpec(modelId);
  const { modelDir, archivePath } = getSherpaOnnxModelPaths(modelsDir, modelId);
  return (
    !(await isNonEmptyFile(archivePath)) && (await hasRequiredFiles(modelDir, spec.requiredFiles))
  );
}

async function isNonEmptyFile(filePath: string): Promise<boolean> {
  try {
    const s = await stat(filePath);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

export async function ensureSherpaOnnxModel(
  options: EnsureSherpaOnnxModelOptions,
): Promise<string> {
  const logger = options.logger.child({
    module: "speech",
    provider: "local",
    component: "model-downloader",
    modelId: options.modelId,
  });

  const spec = getSherpaOnnxModelSpec(options.modelId);
  const { modelDir, archivePath, extractionDir } = getSherpaOnnxModelPaths(
    options.modelsDir,
    options.modelId,
  );
  if (await isSherpaOnnxModelInstalled(options.modelsDir, options.modelId)) {
    return modelDir;
  }

  logger.info({ modelsDir: options.modelsDir }, "Starting model download");

  try {
    if (!(await isNonEmptyFile(archivePath))) {
      await downloadToFile({
        url: spec.archiveUrl,
        outputPath: archivePath,
        signal: options.signal,
      });
    }

    logger.info(
      {
        modelId: options.modelId,
        archivePath,
        modelDir,
      },
      "Extracting model archive",
    );
    // Extract beside the archive and move into place once complete, so an interrupted
    // extraction never leaves partial files at modelDir.
    await rm(extractionDir, { recursive: true, force: true });
    try {
      await extractTarArchive(archivePath, extractionDir, options.signal);
      const extractedModelDir = path.join(extractionDir, spec.extractedDir);

      logger.info(
        {
          modelId: options.modelId,
          modelDir,
        },
        "Verifying downloaded model files",
      );
      if (!(await hasRequiredFiles(extractedModelDir, spec.requiredFiles))) {
        throw new Error(
          `Downloaded and extracted ${path.basename(archivePath)}, but required files are missing.`,
        );
      }

      logger.info(
        {
          modelId: options.modelId,
          archivePath,
        },
        "Finalizing model artifacts",
      );
      // A retained archive marks the model as not installed, so remove it before the model
      // is moved into place. If removal fails, nothing at modelDir looks installed.
      await rm(modelDir, { recursive: true, force: true });
      await rm(archivePath, { force: true, maxRetries: 3 });
      await rename(extractedModelDir, modelDir);
    } finally {
      await rm(extractionDir, { recursive: true, force: true });
    }

    logger.info({ modelDir }, "Model download completed");
    return modelDir;
  } catch (error) {
    logger.error({ err: error }, "Model download failed");
    throw error;
  }
}

export async function ensureSherpaOnnxModels(options: {
  modelsDir: string;
  modelIds: SherpaOnnxModelId[];
  logger: pino.Logger;
  signal?: AbortSignal;
}): Promise<Record<SherpaOnnxModelId, string>> {
  const uniq = Array.from(new Set(options.modelIds));
  const entries: Array<[SherpaOnnxModelId, string]> = await Promise.all(
    uniq.map(async (id) => {
      const modelPath = await ensureSherpaOnnxModel({
        modelsDir: options.modelsDir,
        modelId: id,
        logger: options.logger,
        signal: options.signal,
      });
      return [id, modelPath] as [SherpaOnnxModelId, string];
    }),
  );
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return Object.fromEntries(entries) as Record<SherpaOnnxModelId, string>;
}
