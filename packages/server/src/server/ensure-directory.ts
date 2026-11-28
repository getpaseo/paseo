import { mkdir, stat } from "node:fs/promises";

/**
 * Create a directory only when it is missing.
 *
 * `mkdir(recursive: true)` cannot create an existing filesystem root: on Windows
 * `mkdir("D:\\")` fails with `EPERM`, and the recursive mkdir does not swallow it.
 * An existing root therefore has to be recognized before calling `mkdir`.
 */
export async function ensureDirectory(directoryPath: string): Promise<void> {
  if (await stat(directoryPath).catch(() => null)) {
    return;
  }
  await mkdir(directoryPath, { recursive: true });
}
