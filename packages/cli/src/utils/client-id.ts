import { ensurePrivateDirectory } from "@getpaseo/server";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

function normalizeClientId(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function generateClientId(): string {
  return `cid_${randomUUID().replace(/-/g, "")}`;
}

export async function getOrCreateCliClientId(home: string): Promise<string> {
  const clientSessionKeyFile = join(home, "cli-client-id");

  try {
    const existing = normalizeClientId(await readFile(clientSessionKeyFile, "utf8"));
    if (existing) {
      return existing;
    }
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  const nextValue = generateClientId();
  ensurePrivateDirectory(home);
  await writeFile(clientSessionKeyFile, nextValue, { mode: 0o600 });
  return nextValue;
}
