import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

function chmodBestEffort(targetPath: string, mode: number): void {
  if (process.platform === "win32") {
    return;
  }

  try {
    chmodSync(targetPath, mode);
  } catch {
    // Keep startup resilient if the filesystem does not support POSIX modes.
  }
}

export function ensurePrivateDirectory(directoryPath: string): void {
  mkdirSync(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  chmodBestEffort(directoryPath, PRIVATE_DIRECTORY_MODE);
}

export function ensurePrivateFile(filePath: string): void {
  chmodBestEffort(filePath, PRIVATE_FILE_MODE);
}

export function writePrivateFileSync(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
): void {
  ensurePrivateDirectory(path.dirname(filePath));
  writeFileSync(filePath, data, { mode: PRIVATE_FILE_MODE });
  ensurePrivateFile(filePath);
}

export function writePrivateFileAtomicSync(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
): void {
  ensurePrivateDirectory(path.dirname(filePath));
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(tmpPath, data, { mode: PRIVATE_FILE_MODE });
    renameSync(tmpPath, filePath);
    ensurePrivateFile(filePath);
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
}
