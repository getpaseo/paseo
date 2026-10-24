import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export async function writeFileAtomic(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
  options?: { durable: boolean },
): Promise<void> {
  const directoryPath = path.dirname(filePath);
  const created = await fs.mkdir(directoryPath, {
    recursive: true,
    ...(options?.durable ? { mode: 0o700 } : {}),
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
    if (options?.durable) {
      const stop = created ? path.dirname(created) : directoryPath;
      let current = directoryPath;
      while (true) {
        const handle = await fs.open(current, "r");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        if (current === stop) break;
        current = path.dirname(current);
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
