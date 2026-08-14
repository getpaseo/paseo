import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export async function writeFileAtomic(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(tempPath, data, "utf8");
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

export async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  await writeFileAtomic(filePath, JSON.stringify(value, null, 2));
}

function toBuffer(data: string | NodeJS.ArrayBufferView): Buffer {
  if (typeof data === "string") {
    return Buffer.from(data, "utf8");
  }
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

async function syncParentDirectory(directoryPath: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const directory = await fs.open(directoryPath, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** Durable atomic write for lifecycle authority state. */
export async function writeFileAtomicDurable(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
): Promise<void> {
  const directoryPath = path.dirname(filePath);
  await fs.mkdir(directoryPath, { recursive: true });
  const tempPath = path.join(
    directoryPath,
    "." + path.basename(filePath) + "." + process.pid + "." + Date.now() + "." + randomUUID() + ".tmp",
  );
  const expected = toBuffer(data);
  let renamed = false;
  try {
    const handle = await fs.open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(expected);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tempPath, filePath);
    renamed = true;
    const persisted = await fs.readFile(filePath);
    if (!persisted.equals(expected)) {
      throw new Error("Atomic durable write verification failed: " + filePath);
    }
    await syncParentDirectory(directoryPath);
  } catch (error) {
    if (!renamed) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
    }
    throw error;
  }
}

export async function writeJsonFileAtomicDurable(
  filePath: string,
  value: unknown,
): Promise<void> {
  await writeFileAtomicDurable(filePath, JSON.stringify(value, null, 2));
}
