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
}

async function downloadToFile(options: DownloadToFileOptions): Promise<void> {
  const { url, outputPath } = options;
  const res = await fetch(url);
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
    await pipeline(nodeStream, createWriteStream(tmpPath));
    await rename(tmpPath, outputPath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function extractTarArchive(archivePath: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const child = spawnProcess("tar", ["xf", archivePath, "-C", destDir], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited with code ${code}`));
    });
  });
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
  const modelDir = path.join(options.modelsDir, spec.extractedDir);
  if (await hasRequiredFiles(modelDir, spec.requiredFiles)) {
    return modelDir;
  }

  logger.info({ modelsDir: options.modelsDir }, "Starting model download");

  try {
    if (spec.archiveUrl) {
      const downloadsDir = path.join(options.modelsDir, ".downloads");
      const archiveFilename = path.basename(new URL(spec.archiveUrl).pathname);
      const archivePath = path.join(downloadsDir, archiveFilename);

      if (!(await isNonEmptyFile(archivePath))) {
        await downloadToFile({
          url: spec.archiveUrl,
          outputPath: archivePath,
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
      await extractTarArchive(archivePath, options.modelsDir);

      logger.info(
        {
          modelId: options.modelId,
          modelDir,
        },
        "Verifying downloaded model files",
      );
      if (!(await hasRequiredFiles(modelDir, spec.requiredFiles))) {
        throw new Error(
          `Downloaded and extracted ${archiveFilename}, but required files are still missing in ${modelDir}.`,
        );
      }

      logger.info(
        {
          modelId: options.modelId,
          archivePath,
        },
        "Finalizing model artifacts",
      );
      try {
        await rm(archivePath, { force: true });
      } catch {
        // ignore
      }

      logger.info({ modelDir }, "Model download completed");
      return modelDir;
    }

    if (spec.downloadFiles && spec.downloadFiles.length > 0) {
      await mkdir(modelDir, { recursive: true });

      await Promise.all(
        spec.downloadFiles.map(async (file) => {
          const dst = path.join(modelDir, file.relPath);
          if (await isNonEmptyFile(dst)) {
            return;
          }
          await downloadToFile({
            url: file.url,
            outputPath: dst,
          });
        }),
      );

      logger.info(
        {
          modelId: options.modelId,
          modelDir,
        },
        "Verifying downloaded model files",
      );
      if (!(await hasRequiredFiles(modelDir, spec.requiredFiles))) {
        throw new Error(
          `Downloaded files for ${options.modelId}, but required files are still missing in ${modelDir}.`,
        );
      }

      logger.info({ modelDir }, "Model download completed");
      return modelDir;
    }

    throw new Error(`Model spec for ${options.modelId} has no archiveUrl or downloadFiles`);
  } catch (error) {
    logger.error({ err: error }, "Model download failed");
    throw error;
  }
}

export async function ensureSherpaOnnxModels(options: {
  modelsDir: string;
  modelIds: SherpaOnnxModelId[];
  logger: pino.Logger;
}): Promise<Record<SherpaOnnxModelId, string>> {
  const uniq = Array.from(new Set(options.modelIds));
  const entries: Array<[SherpaOnnxModelId, string]> = await Promise.all(
    uniq.map(async (id) => {
      const modelPath = await ensureSherpaOnnxModel({
        modelsDir: options.modelsDir,
        modelId: id,
        logger: options.logger,
      });
      return [id, modelPath] as [SherpaOnnxModelId, string];
    }),
  );
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return Object.fromEntries(entries) as Record<SherpaOnnxModelId, string>;
}
