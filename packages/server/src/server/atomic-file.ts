import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export async function writeFileAtomic(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
  options?: { durable: boolean },
): Promise<void> {
  const directoryPath = path.dirname(filePath);
  await fs.mkdir(directoryPath, {
    recursive: true,
    mode: options?.durable ? 0o700 : undefined,
  });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  try {
    if (options?.durable) {
      const handle = await fs.open(tempPath, "wx", 0o600);
      try {
        await handle.writeFile(
          typeof data === "string" || data instanceof Uint8Array
            ? data
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
    } else {
      await fs.writeFile(tempPath, data, "utf8");
    }
    await fs.rename(tempPath, filePath);
    // Windows cannot open or fsync a directory; the file is synced and the rename is not
    // proven durable there, so managed creation is unqualified on Windows hosts.
    if (options?.durable && process.platform !== "win32") {
      let current = directoryPath;
      while (true) {
        const handle = await fs.open(current, "r");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

export async function writeJsonFileAtomic(
  filePath: string,
  value: unknown,
  options?: { durable: boolean },
): Promise<void> {
  await writeFileAtomic(filePath, JSON.stringify(value, null, 2), options);
}
