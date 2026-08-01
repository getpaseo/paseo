import { resolve } from "node:path";

const cleanupTails = new Map<string, Promise<void>>();

export async function withWorkspaceCleanupLock<T>(
  directoryPath: string,
  task: () => Promise<T>,
): Promise<T> {
  const key = resolve(directoryPath);
  const previous = cleanupTails.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const current = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  cleanupTails.set(key, current);

  await previous;
  try {
    return await task();
  } finally {
    release();
    if (cleanupTails.get(key) === current) {
      cleanupTails.delete(key);
    }
  }
}
