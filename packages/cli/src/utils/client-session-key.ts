import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const CLIENT_SESSION_KEY_FILE = join(
  process.env.PASEO_HOME ?? join(homedir(), ".paseo"),
  "cli-client-session-key"
);

let cachedClientSessionKey: string | null = null;

function normalizeClientSessionKey(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function generateClientSessionKey(): string {
  return `clsk_${randomUUID().replace(/-/g, "")}`;
}

export async function getOrCreateCliClientSessionKey(): Promise<string> {
  if (cachedClientSessionKey) {
    return cachedClientSessionKey;
  }

  try {
    const existing = normalizeClientSessionKey(
      await readFile(CLIENT_SESSION_KEY_FILE, "utf8")
    );
    if (existing) {
      cachedClientSessionKey = existing;
      return existing;
    }
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  const nextValue = generateClientSessionKey();
  await mkdir(dirname(CLIENT_SESSION_KEY_FILE), { recursive: true });
  await writeFile(CLIENT_SESSION_KEY_FILE, nextValue, { mode: 0o600 });
  cachedClientSessionKey = nextValue;
  return nextValue;
}
