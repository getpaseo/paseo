import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import type pino from "pino";

import { getSherpaOnnxModelSpec, type SherpaOnnxModelId } from "./model-catalog.js";

export type EnsureSherpaOnnxModelOptions = {
  modelsDir: string;
  modelId: SherpaOnnxModelId;
  autoDownload: boolean;
  logger: pino.Logger;
};

export function getSherpaOnnxModelDir(modelsDir: string, modelId: SherpaOnnxModelId): string {
  const spec = getSherpaOnnxModelSpec(modelId);
  return path.join(modelsDir, spec.extractedDir);
}

async function hasRequiredFiles(modelDir: string, requiredFiles: string[]): Promise<boolean> {
  for (const rel of requiredFiles) {
    const abs = path.join(modelDir, rel);
    try {
      const s = await stat(abs);
      if (s.isDirectory()) {
        continue;
      }
      if (s.isFile() && s.size > 0) {
        continue;
      }
      return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function downloadToFile(url: string, outputPath: string, logger: pino.Logger): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
  }
  if (!res.body) {
    throw new Error(`Failed to download ${url}: missing response body`);
  }

  const tmpPath = `${outputPath}.tmp-${Date.now()}`;
  await mkdir(path.dirname(outputPath), { recursive: true });

  const total = Number(res.headers.get("content-length") ?? "0");
  let downloaded = 0;
  let lastLoggedBucket = -1;

  const nodeStream = Readable.fromWeb(res.body as any).on("data", (chunk: Buffer) => {
    downloaded += chunk.length;
    if (total > 0) {
      const pct = Math.floor((downloaded / total) * 100);
      const bucket = Math.min(100, Math.floor(pct / 10) * 10);
      if (bucket >= 0 && bucket <= 100 && bucket !== lastLoggedBucket) {
        lastLoggedBucket = bucket;
        logger.info({ pct: bucket, downloaded, total }, "Downloading model artifact");
      }
    }
  });

  await pipeline(nodeStream, createWriteStream(tmpPath));
  await rename(tmpPath, outputPath);
}

async function extractTarArchive(archivePath: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["xf", archivePath, "-C", destDir], { stdio: "inherit" });
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

export async function ensureSherpaOnnxModel(options: EnsureSherpaOnnxModelOptions): Promise<string> {
  const logger = options.logger.child({
    module: "speech",
    provider: "sherpa-onnx",
    component: "model-downloader",
    modelId: options.modelId,
  });

  const spec = getSherpaOnnxModelSpec(options.modelId);
  const modelDir = path.join(options.modelsDir, spec.extractedDir);
  if (await hasRequiredFiles(modelDir, spec.requiredFiles)) {
    return modelDir;
  }

  if (!options.autoDownload) {
    throw new Error(
      `Missing sherpa-onnx model files for ${options.modelId} in ${modelDir}. ` +
        `Set PASEO_SHERPA_ONNX_AUTO_DOWNLOAD=1 to auto-download.`
    );
  }

  if (spec.archiveUrl) {
    logger.info({ modelsDir: options.modelsDir, url: spec.archiveUrl }, "Model files missing; downloading");

    const downloadsDir = path.join(options.modelsDir, ".downloads");
    const archiveFilename = path.basename(new URL(spec.archiveUrl).pathname);
    const archivePath = path.join(downloadsDir, archiveFilename);

    if (!(await isNonEmptyFile(archivePath))) {
      await downloadToFile(spec.archiveUrl, archivePath, logger);
    } else {
      logger.info({ archivePath }, "Using cached archive");
    }

    await extractTarArchive(archivePath, options.modelsDir);

    if (!(await hasRequiredFiles(modelDir, spec.requiredFiles))) {
      throw new Error(
        `Downloaded and extracted ${archiveFilename}, but required files are still missing in ${modelDir}.`
      );
    }

    try {
      await rm(archivePath, { force: true });
    } catch {
      // ignore
    }

    logger.info({ modelDir }, "Model ready");
    return modelDir;
  }

  if (spec.downloadFiles && spec.downloadFiles.length > 0) {
    logger.info({ modelsDir: options.modelsDir, fileCount: spec.downloadFiles.length }, "Model files missing; downloading");
    await mkdir(modelDir, { recursive: true });

    for (const file of spec.downloadFiles) {
      const dst = path.join(modelDir, file.relPath);
      if (await isNonEmptyFile(dst)) {
        continue;
      }
      await downloadToFile(file.url, dst, logger);
    }

    if (!(await hasRequiredFiles(modelDir, spec.requiredFiles))) {
      throw new Error(
        `Downloaded files for ${options.modelId}, but required files are still missing in ${modelDir}.`
      );
    }

    logger.info({ modelDir }, "Model ready");
    return modelDir;
  }

  throw new Error(`Model spec for ${options.modelId} has no archiveUrl or downloadFiles`);
}

export async function ensureSherpaOnnxModels(options: {
  modelsDir: string;
  modelIds: SherpaOnnxModelId[];
  autoDownload: boolean;
  logger: pino.Logger;
}): Promise<Record<SherpaOnnxModelId, string>> {
  const uniq = Array.from(new Set(options.modelIds));
  const out: Partial<Record<SherpaOnnxModelId, string>> = {};
  for (const id of uniq) {
    out[id] = await ensureSherpaOnnxModel({
      modelsDir: options.modelsDir,
      modelId: id,
      autoDownload: options.autoDownload,
      logger: options.logger,
    });
  }
  return out as Record<SherpaOnnxModelId, string>;
}
