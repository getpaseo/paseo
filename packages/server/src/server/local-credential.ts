import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  normalizeLoopbackToLocalhost,
  parseConnectionUri,
} from "@getpaseo/protocol/daemon-endpoints";

const FILE_NAME = "local-credential";

export async function writeLocalCredential(home: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const temporary = join(home, `${FILE_NAME}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${token}\n`, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, join(home, FILE_NAME));
    return token;
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function deleteLocalCredential(home: string): Promise<void> {
  await unlink(join(home, FILE_NAME)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

export function readLocalCredential(home: string): string | null {
  try {
    const token = readFileSync(join(home, FILE_NAME), "utf8").trim();
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

export function matchesLocalCredential(expected: string, candidate: string): boolean {
  const actual = Buffer.from(candidate);
  const reference = Buffer.from(expected);
  return actual.length === reference.length && timingSafeEqual(actual, reference);
}

function normalizeTarget(target: string): string | null {
  try {
    const trimmed = target.trim();
    if (trimmed.startsWith("tcp://")) {
      const parsed = parseConnectionUri(trimmed);
      const endpoint = parsed.isIpv6
        ? `[${parsed.host}]:${parsed.port}`
        : `${parsed.host}:${parsed.port}`;
      return normalizeLoopbackToLocalhost(endpoint);
    }
    if (trimmed.startsWith("unix://") || trimmed.startsWith("pipe://")) return trimmed;
    if (trimmed.startsWith("/")) return `unix://${trimmed}`;
    if (trimmed.startsWith("\\\\.\\pipe\\")) return `pipe://${trimmed}`;
    if (/^\d+$/.test(trimmed)) return `localhost:${trimmed}`;
    return normalizeLoopbackToLocalhost(trimmed);
  } catch {
    return null;
  }
}

export function readLocalCredentialForTarget(home: string, target: string): string | null {
  try {
    const lock = JSON.parse(readFileSync(join(home, "paseo.pid"), "utf8")) as {
      listen?: unknown;
    };
    if (typeof lock.listen !== "string") return null;
    const selected = normalizeTarget(target);
    const listening = normalizeTarget(lock.listen);
    if (!selected || !listening || selected !== listening) return null;
    return readLocalCredential(home);
  } catch {
    return null;
  }
}
