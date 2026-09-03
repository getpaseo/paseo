import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { resolvePaseoHome } from "@getpaseo/server";

// Resolved per call: commands such as `daemon pair` set PASEO_HOME at runtime,
// so a module-load-time path would point at the wrong home.
function clientIdFilePath(): string {
  return join(resolvePaseoHome(), "cli-client-id");
}

let cachedClientId: string | null = null;

function normalizeClientId(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function generateClientId(): string {
  return `cid_${randomUUID().replace(/-/g, "")}`;
}

export async function getOrCreateCliClientId(): Promise<string> {
  if (cachedClientId) {
    return cachedClientId;
  }

  const clientIdFile = clientIdFilePath();

  try {
    const existing = normalizeClientId(await readFile(clientIdFile, "utf8"));
    if (existing) {
      cachedClientId = existing;
      return existing;
    }
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  const nextValue = generateClientId();
  await mkdir(dirname(clientIdFile), { recursive: true });
  await writeFile(clientIdFile, nextValue, { mode: 0o600 });
  cachedClientId = nextValue;
  return nextValue;
}
