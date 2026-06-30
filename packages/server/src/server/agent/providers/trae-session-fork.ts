import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Location of Trae CLI's persisted ACP sessions. Trae stores each session as a
 * DIRECTORY `<uuid>/` containing `session.json` (metadata), `events.jsonl`
 * (conversation event log), and `traces.jsonl` (telemetry spans).
 *
 * Default location is platform-specific (macOS uses `~/Library/Caches`, Linux
 * uses the XDG cache dir); overridable via `TRAE_SESSIONS_DIR` (used by tests
 * and to point at a non-default install).
 */
export function resolveTraeSessionsDir(): string {
  const override = process.env.TRAE_SESSIONS_DIR;
  if (override && override.trim()) {
    return override.trim();
  }
  if (process.platform === "darwin") {
    return path.join(homedir(), "Library", "Caches", "trae-cli", "sessions");
  }
  const xdgCache = process.env.XDG_CACHE_HOME?.trim() || path.join(homedir(), ".cache");
  return path.join(xdgCache, "trae-cli", "sessions");
}

/**
 * Duplicate a Trae CLI session directory into a new session id, preserving the
 * FULL conversation context. The fork:
 *
 * 1. Recursively copies the source session directory to `<newId>/`.
 * 2. Rewrites `session.json` → updates `id` to the new uuid (+ optional title).
 * 3. Rewrites `events.jsonl` / `traces.jsonl` → replaces every occurrence of the
 *    source session uuid with the new uuid.
 *
 * The id is a full UUID, so replacing every occurrence of that exact string is
 * safe and order-independent (no dependency on Trae's field serialization
 * order). All I/O is async (`fs/promises`) so it never blocks the daemon's
 * event loop. Returns the new session id. Throws if the source dir is missing.
 *
 * This is a real fork: the new id is an independent, loadable Trae CLI session
 * that carries the original's full context. The original is never mutated.
 */
export async function forkTraeSessionFiles(input: {
  sessionsDir: string;
  sourceId: string;
  newId?: string;
  titleSuffix?: string;
}): Promise<string> {
  const { sessionsDir, sourceId } = input;
  const newId = input.newId ?? randomUUID();

  const sourceDir = path.join(sessionsDir, sourceId);
  if (!existsSync(sourceDir)) {
    throw new Error(`Trae session directory not found: ${sourceDir}`);
  }

  const destDir = path.join(sessionsDir, newId);

  // 1. Recursively copy the entire session directory.
  await cp(sourceDir, destDir, { recursive: true });

  // 2. Rewrite session.json: update `id` field and optionally annotate title.
  const sessionJsonPath = path.join(destDir, "session.json");
  if (existsSync(sessionJsonPath)) {
    const metadata = JSON.parse(await readFile(sessionJsonPath, "utf8")) as Record<string, unknown>;
    metadata.id = newId;
    const meta = metadata.metadata;
    if (
      input.titleSuffix &&
      typeof meta === "object" &&
      meta !== null &&
      typeof (meta as Record<string, unknown>).title === "string"
    ) {
      (meta as Record<string, unknown>).title =
        `${(meta as Record<string, unknown>).title}${input.titleSuffix}`;
    }
    await writeFile(sessionJsonPath, JSON.stringify(metadata), "utf8");
  }

  // 3. Rewrite the event log + telemetry traces: replace every occurrence of the
  // source uuid with the new one. The uuid is unique, so a blanket replace is
  // safe and independent of Trae's JSON field ordering.
  for (const file of ["events.jsonl", "traces.jsonl"]) {
    const filePath = path.join(destDir, file);
    if (existsSync(filePath)) {
      const content = await readFile(filePath, "utf8");
      await writeFile(filePath, content.replaceAll(sourceId, newId), "utf8");
    }
  }

  return newId;
}
