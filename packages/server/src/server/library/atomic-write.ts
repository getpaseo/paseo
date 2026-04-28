import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

export interface AtomicWriteOptions {
  /** POSIX mode bits applied via chmod after rename. e.g. 0o600 for secrets. */
  mode?: number;
}

/**
 * Write a file by writing to a sibling temp path and renaming. The rename is
 * atomic on the same filesystem so partial writes never become observable.
 * When `mode` is set, applies chmod after rename — useful for files that
 * contain secrets (env vars, headers).
 */
export async function writeFileAtomic(
  targetPath: string,
  payload: string | Buffer,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const directory = path.dirname(targetPath);
  await fs.mkdir(directory, { recursive: true });
  const tempPath = path.join(
    directory,
    `.hubcode.tmp-${process.pid}-${Date.now()}-${randomUUID()}`,
  );
  await fs.writeFile(tempPath, payload, options.mode !== undefined ? { mode: options.mode } : {});
  await fs.rename(tempPath, targetPath);
  if (options.mode !== undefined && process.platform !== "win32") {
    await fs.chmod(targetPath, options.mode);
  }
}

export async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  }
}
