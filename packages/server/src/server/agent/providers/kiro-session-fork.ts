import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, cp, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Location of Kiro CLI's persisted ACP sessions. Kiro stores each session as
 * `<id>.json` (metadata + reconstructable `session_state`), `<id>.jsonl` (event
 * log) and `<id>.history` under `~/.kiro/sessions/cli`. Overridable via
 * `KIRO_SESSIONS_DIR` (used by tests).
 */
export function resolveKiroSessionsDir(): string {
  const override = process.env.KIRO_SESSIONS_DIR;
  if (override && override.trim()) {
    return override.trim();
  }
  return path.join(homedir(), ".kiro", "sessions", "cli");
}

/**
 * Duplicate a Kiro session on disk into a new session id, preserving the FULL
 * conversation context. Kiro reconstructs a session from the `session_state`
 * embedded in `<id>.json`, so a faithful fork copies every session file and
 * rewrites the internal `session_id` to the new id. Returns the new id.
 *
 * This is a real fork (the new id is an independent, loadable Kiro session that
 * carries the original's context) — not a cosmetic timeline snapshot. Mid-point
 * truncation is intentionally NOT attempted: `session_state.rts_model_state` is
 * an opaque model-side blob that cannot be safely truncated, so the fork
 * duplicates the whole conversation and the branch continues from its end.
 *
 * All file I/O is async (`fs/promises`) so the copy never blocks the daemon's
 * event loop while other sessions are mid-IPC. Throws if the source metadata
 * file does not exist.
 */
export async function forkKiroSessionFiles(input: {
  sessionsDir: string;
  sourceId: string;
  newId?: string;
  titleSuffix?: string;
}): Promise<string> {
  const { sessionsDir, sourceId } = input;
  const newId = input.newId ?? randomUUID();

  const sourceJsonPath = path.join(sessionsDir, `${sourceId}.json`);
  if (!existsSync(sourceJsonPath)) {
    throw new Error(`Kiro session metadata not found: ${sourceJsonPath}`);
  }

  // Metadata: rewrite session_id (filename and internal id must agree) and
  // optionally annotate the title so the fork is recognizable.
  const metadata = JSON.parse(await readFile(sourceJsonPath, "utf8")) as Record<string, unknown>;
  metadata.session_id = newId;
  if (input.titleSuffix && typeof metadata.title === "string") {
    metadata.title = `${metadata.title}${input.titleSuffix}`;
  }
  await writeFile(path.join(sessionsDir, `${newId}.json`), JSON.stringify(metadata), "utf8");

  // Event log + readline history: verbatim copy when present.
  for (const ext of [".jsonl", ".history"]) {
    const src = path.join(sessionsDir, `${sourceId}${ext}`);
    if (existsSync(src)) {
      await copyFile(src, path.join(sessionsDir, `${newId}${ext}`));
    }
  }

  // Some sessions carry a sidecar directory (`<id>/`); copy it recursively.
  const sidecar = path.join(sessionsDir, sourceId);
  if (existsSync(sidecar)) {
    await cp(sidecar, path.join(sessionsDir, newId), { recursive: true });
  }

  return newId;
}
