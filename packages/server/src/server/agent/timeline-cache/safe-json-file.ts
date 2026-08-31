import { open } from "node:fs/promises";

export async function readJsonFileCapped(filePath: string, maxBytes: number): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("maxBytes must be a positive safe integer");
  }
  const handle = await open(filePath, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`JSON path is not a regular file: '${filePath}'`);
    if (before.size > maxBytes) {
      throw new Error(`JSON file exceeds the ${maxBytes}-byte limit: '${filePath}'`);
    }
    const buffer = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) throw new Error(`JSON file changed while being read: '${filePath}'`);
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error(`JSON file changed while being read: '${filePath}'`);
    }
    return JSON.parse(buffer.toString("utf8"));
  } finally {
    await handle.close();
  }
}
