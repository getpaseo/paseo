import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export async function writeFileAtomic(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
): Promise<void> {
  const dir = path.dirname(filePath);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await fs.mkdir(dir, { recursive: true });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 10 * attempt));
        continue;
      }
      throw error;
    }
  }
  const tempPath = path.join(
    dir,
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
