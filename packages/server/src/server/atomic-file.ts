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
