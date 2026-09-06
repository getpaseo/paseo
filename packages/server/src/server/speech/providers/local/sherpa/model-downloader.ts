import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type pino from "pino";

import { getSherpaOnnxModelSpec, type SherpaOnnxModelId } from "./model-catalog.js";
import { spawnProcess } from "../../../../../utils/spawn.js";

export interface SherpaOnnxDownloadProgress {
  receivedBytes: number;
  totalBytes: number | null;
  percent: number | null;
  stage: "downloading" | "extracting" | "verifying" | "complete";
}

export interface EnsureSherpaOnnxModelOptions {
  modelsDir: string;
  modelId: SherpaOnnxModelId;
  logger: pino.Logger;
  signal?: AbortSignal;
  onProgress?: (progress: SherpaOnnxDownloadProgress) => void;
}

export function getSherpaOnnxModelDir(modelsDir: string, modelId: SherpaOnnxModelId): string {
  const spec = getSherpaOnnxModelSpec(modelId);
  return path.join(modelsDir, spec.extractedDir);
}

export async function hasRequiredFiles(modelDir: string, requiredFiles: string[]): Promise<boolean> {
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

async function verifyFileSha256(filePath: string, expectedHash: string): Promise<boolean> {
  return new Promise((resolve) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => {
      const digest = hash.digest("hex");
      resolve(digest.toLowerCase() === expectedHash.toLowerCase());
    });
    stream.on("error", () => resolve(false));
  });
}

interface DownloadToFileOptions {
  url: string;
  outputPath: string;
  signal?: AbortSignal;
  onProgress?: (progress: Omit<SherpaOnnxDownloadProgress, "stage">) => void;
}

const PROGRESS_EMIT_INTERVAL_MS = 150;
const SEGMENTED_DOWNLOAD_MIN_BYTES = 32 * 1024 * 1024;
const SEGMENTED_DOWNLOAD_CONNECTIONS = 6;
const SEGMENT_MIN_BYTES = 4 * 1024 * 1024;

interface DownloadProgressTracker {
  receivedBytes: number;
  totalBytes: number | null;
  private_lastEmitAt: number;
  emit: () => void;
}

function createProgressTracker(
  totalBytes: number | null,
  onProgress: DownloadToFileOptions["onProgress"],
): DownloadProgressTracker {
  const tracker: DownloadProgressTracker = {
    receivedBytes: 0,
    totalBytes,
    private_lastEmitAt: 0,
    emit: () => {
      if (!onProgress) {
        return;
      }
      const now = Date.now();
      if (now - tracker.private_lastEmitAt < PROGRESS_EMIT_INTERVAL_MS) {
        return;
      }
      tracker.private_lastEmitAt = now;
      const percent =
        totalBytes && totalBytes > 0
          ? Math.min(100, Math.round((tracker.receivedBytes / totalBytes) * 100))
          : null;
      onProgress({ receivedBytes: tracker.receivedBytes, totalBytes, percent });
    },
  };
  return tracker;
}

function counterStream(onChunk: (length: number) => void): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      onChunk(chunk.length);
      callback(null, chunk);
    },
  });
}

interface RangeProbeResult {
  supportsRanges: boolean;
  totalBytes: number | null;
}

async function probeRangeSupport(
  url: string,
  signal: AbortSignal | undefined,
): Promise<RangeProbeResult> {
  const res = await fetch(url, { method: "HEAD", redirect: "follow", signal });
  if (!res.ok) {
    return { supportsRanges: false, totalBytes: null };
  }
  const contentLengthHeader = res.headers.get("content-length");
  const totalBytes = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : null;
  const acceptRanges = res.headers.get("accept-ranges") ?? "";
  if (acceptRanges.toLowerCase().includes("bytes")) {
    return { supportsRanges: true, totalBytes };
  }
  // Some CDNs omit accept-ranges; probe with a 1-byte range request.
  const probe = await fetch(url, {
    headers: { Range: "bytes=0-0" },
    redirect: "follow",
    signal,
  });
  await probe.body?.cancel().catch(() => undefined);
  if (probe.status === 206) {
    const probeLength = probe.headers.get("content-range");
    const total = probeLength ? Number.parseInt(probeLength.split("/")[1] ?? "", 10) : Number.NaN;
    return {
      supportsRanges: true,
      totalBytes: Number.isFinite(total) ? total : totalBytes,
    };
  }
  return { supportsRanges: false, totalBytes };
}

async function downloadSegment(params: {
  url: string;
  outputPath: string;
  start: number;
  end: number;
  signal: AbortSignal | undefined;
  onChunk: (length: number) => void;
}): Promise<void> {
  const { url, outputPath, start, end, signal, onChunk } = params;
  const res = await fetch(url, {
    headers: { Range: `bytes=${start}-${end}` },
    redirect: "follow",
    signal,
  });
  if (res.status !== 206 || !res.body) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`Segment download unsupported (status ${res.status} for bytes=${start}-${end})`);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodeStream = Readable.fromWeb(res.body as any);
  await pipeline(
    nodeStream,
    counterStream(onChunk),
    createWriteStream(outputPath, { start, flags: "r+" }),
    { signal },
  );
}

async function downloadSegmented(params: {
  url: string;
  tmpPath: string;
  totalBytes: number;
  connections: number;
  signal: AbortSignal | undefined;
  tracker: DownloadProgressTracker;
}): Promise<void> {
  const { url, tmpPath, totalBytes, connections, signal, tracker } = params;

  const handle = await open(tmpPath, "w");
  await handle.truncate(totalBytes);
  await handle.close();

  const segmentSize = Math.max(
    SEGMENT_MIN_BYTES,
    Math.ceil(totalBytes / connections),
  );
  const segments: Array<{ start: number; end: number }> = [];
  for (let start = 0; start < totalBytes; start += segmentSize) {
    segments.push({ start, end: Math.min(start + segmentSize, totalBytes) - 1 });
  }

  const onChunk = (length: number): void => {
    tracker.receivedBytes += length;
    tracker.emit();
  };

  await Promise.all(
    segments.map((segment) =>
      downloadSegment({
        url,
        outputPath: tmpPath,
        start: segment.start,
        end: segment.end,
        signal,
        onChunk,
      }),
    ),
  );

  const written = await stat(tmpPath);
  if (written.size !== totalBytes) {
    throw new Error(
      `Segmented download size mismatch: expected ${totalBytes}, got ${written.size}`,
    );
  }
}

async function downloadSingleStream(params: {
  url: string;
  tmpPath: string;
  signal: AbortSignal | undefined;
  tracker: DownloadProgressTracker;
}): Promise<void> {
  const { url, tmpPath, signal, tracker } = params;
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
  }
  if (!res.body) {
    throw new Error(`Failed to download ${url}: missing response body`);
  }

  const contentLengthHeader = res.headers.get("content-length");
  tracker.totalBytes = contentLengthHeader
    ? Number.parseInt(contentLengthHeader, 10)
    : tracker.totalBytes;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodeStream = Readable.fromWeb(res.body as any);
  await pipeline(nodeStream, counterStream((length) => {
    tracker.receivedBytes += length;
    tracker.emit();
  }), createWriteStream(tmpPath), { signal });
}

async function downloadToFile(options: DownloadToFileOptions): Promise<void> {
  const { url, outputPath, signal } = options;
  await mkdir(path.dirname(outputPath), { recursive: true });

  const tmpPath = `${outputPath}.tmp-${Date.now()}`;
  const tracker = createProgressTracker(null, options.onProgress);

  try {
    const probe = await probeRangeSupport(url, signal);
    tracker.totalBytes = probe.totalBytes;

    const canSegment =
      probe.supportsRanges &&
      probe.totalBytes !== null &&
      probe.totalBytes >= SEGMENTED_DOWNLOAD_MIN_BYTES;

    if (canSegment && probe.totalBytes !== null) {
      const totalBytes = probe.totalBytes;
      try {
        await downloadSegmented({
          url,
          tmpPath,
          totalBytes,
          connections: Math.min(
            SEGMENTED_DOWNLOAD_CONNECTIONS,
            Math.max(1, Math.floor(totalBytes / SEGMENT_MIN_BYTES)),
          ),
          signal,
          tracker,
        });
      } catch (error) {
        if (signal?.aborted) {
          throw error;
        }
        options.onProgress?.({ receivedBytes: 0, totalBytes, percent: 0 });
        tracker.receivedBytes = 0;
        await rm(tmpPath, { force: true }).catch(() => undefined);
        await downloadSingleStream({ url, tmpPath, signal, tracker });
      }
    } else {
      await downloadSingleStream({ url, tmpPath, signal, tracker });
    }

    options.onProgress?.({
      receivedBytes: tracker.receivedBytes,
      totalBytes: tracker.totalBytes,
      percent: 100,
    });
    await rename(tmpPath, outputPath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function validateTarArchiveEntries(
  archivePath: string,
  destDir: string,
  signal?: AbortSignal,
): Promise<void> {
  const listingOutput = await new Promise<string>((resolve, reject) => {
    let stdout = "";
    const child = spawnProcess("tar", ["tf", archivePath], { signal });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`tar listing exited with code ${code}`));
    });
  });

  const resolvedDest = path.resolve(destDir);
  const entries = listingOutput.split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (path.isAbsolute(trimmed) || /^[a-zA-Z]:/.test(trimmed)) {
      throw new Error(`Archive contains unsafe absolute entry: ${trimmed}`);
    }
    const targetPath = path.resolve(resolvedDest, trimmed);
    const relative = path.relative(resolvedDest, targetPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Archive contains path traversal entry: ${trimmed}`);
    }
  }
}

async function extractTarArchive(
  archivePath: string,
  destDir: string,
  signal?: AbortSignal,
): Promise<void> {
  await mkdir(destDir, { recursive: true });
  await validateTarArchiveEntries(archivePath, destDir, signal);

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

  if (!spec.archiveUrl) {
    return modelDir;
  }

  logger.info({ modelsDir: options.modelsDir }, "Starting model download");

  const emitProgress = options.onProgress;

  const downloadsDir = path.join(options.modelsDir, ".downloads");
  await mkdir(downloadsDir, { recursive: true });

  const archivePath = path.join(downloadsDir, path.basename(spec.archiveUrl));

  if (!(await isNonEmptyFile(archivePath))) {
    logger.info({ archiveUrl: spec.archiveUrl, archivePath }, "Downloading archive");
    await downloadToFile({
      url: spec.archiveUrl,
      outputPath: archivePath,
      signal: options.signal,
      onProgress: (progress) =>
        emitProgress?.({ ...progress, stage: "downloading" }),
    });
  }

  if (spec.archiveUrl) {
    if (!spec.sha256) {
      throw new Error(`Model archive for ${options.modelId} requires a verified sha256 checksum`);
    }
    emitProgress?.({ receivedBytes: 0, totalBytes: null, percent: null, stage: "verifying" });
    const valid = await verifyFileSha256(archivePath, spec.sha256);
    if (!valid) {
      await rm(archivePath, { force: true }).catch(() => undefined);
      throw new Error(`SHA256 checksum mismatch for ${spec.archiveUrl}`);
    }
    logger.info("Model archive checksum verified successfully");
  }

  logger.info({ archivePath, modelDir }, "Extracting model archive");
  emitProgress?.({ receivedBytes: 0, totalBytes: null, percent: null, stage: "extracting" });
  await extractTarArchive(archivePath, options.modelsDir, options.signal);

  if (!(await hasRequiredFiles(modelDir, spec.requiredFiles))) {
    throw new Error(`Model extraction did not produce required files in ${modelDir}`);
  }

  await rm(archivePath, { force: true }).catch(() => undefined);

  emitProgress?.({ receivedBytes: 0, totalBytes: null, percent: 100, stage: "complete" });

  return modelDir;
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
