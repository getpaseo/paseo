import { chmodSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

function applyPrivateMode(target: string, mode: number): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(target, mode);
  } catch {
    // Permissions are not portable; creation must still work on such filesystems.
  }
}

export function ensurePrivateDirectory(directoryPath: string): void {
  mkdirSync(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  applyPrivateMode(directoryPath, PRIVATE_DIRECTORY_MODE);
}

export function ensurePrivateFile(filePath: string): void {
  applyPrivateMode(filePath, PRIVATE_FILE_MODE);
}

export function writePrivateFileAtomicSync(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
): void {
  ensurePrivateDirectory(path.dirname(filePath));
  const destination = resolveSymlinkedFile(filePath);
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${randomUUID()}`,
  );
  try {
    writeFileSync(temporary, data, { mode: PRIVATE_FILE_MODE });
    renameSync(temporary, destination);
    ensurePrivateFile(destination);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

// Renaming onto a symlink replaces the link, so write to the file it points at.
function resolveSymlinkedFile(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return filePath;
    throw error;
  }
}
