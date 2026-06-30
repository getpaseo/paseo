import { randomUUID } from "node:crypto";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Location of Trae CLI's persisted ACP sessions. Trae stores each session as a
 * DIRECTORY `<uuid>/` containing `session.json` (metadata), `events.jsonl`
 * (conversation event log), and `traces.jsonl` (telemetry spans) under
 * `~/Library/Caches/trae-cli/sessions/`. Overridable via `TRAE_SESSIONS_DIR`
 * (used by tests).
 */
export function resolveTraeSessionsDir(): string {
  const override = process.env.TRAE_SESSIONS_DIR;
  if (override && override.trim()) {
    return override.trim();
  }
  return path.join(homedir(), "Library", "Caches", "trae-cli", "sessions");
}

/**
 * Duplicate a Trae CLI session directory into a new session id, preserving the
 * FULL conversation context. The fork:
 *
 * 1. Recursively copies the source session directory to `<newId>/`.
 * 2. Rewrites `session.json` → updates `id` to the new uuid.
 * 3. Rewrites `events.jsonl` → replaces `session_id` in every event line.
 * 4. Rewrites `traces.jsonl` → replaces `telemetry.session.id` tag values.
 *
 * Returns the new session id. Throws if the source directory does not exist.
 *
 * This is a real fork: the new id is an independent, loadable Trae CLI session
 * that carries the original's full context. The original session is never
 * mutated, so the two can run in parallel.
 */
export function forkTraeSessionFiles(input: {
  sessionsDir: string;
  sourceId: string;
  newId?: string;
  titleSuffix?: string;
}): string {
  const { sessionsDir, sourceId } = input;
  const newId = input.newId ?? randomUUID();

  const sourceDir = path.join(sessionsDir, sourceId);
  if (!existsSync(sourceDir)) {
    throw new Error(`Trae session directory not found: ${sourceDir}`);
  }

  const destDir = path.join(sessionsDir, newId);

  // 1. Recursively copy the entire session directory.
  cpSync(sourceDir, destDir, { recursive: true });

  // 2. Rewrite session.json: update `id` field and optionally annotate title.
  const sessionJsonPath = path.join(destDir, "session.json");
  if (existsSync(sessionJsonPath)) {
    const metadata = JSON.parse(readFileSync(sessionJsonPath, "utf8")) as Record<string, unknown>;
    metadata.id = newId;
    if (
      input.titleSuffix &&
      typeof metadata.metadata === "object" &&
      metadata.metadata !== null &&
      "title" in metadata.metadata &&
      typeof (metadata.metadata as Record<string, unknown>).title === "string"
    ) {
      (metadata.metadata as Record<string, unknown>).title =
        `${(metadata.metadata as Record<string, unknown>).title}${input.titleSuffix}`;
    }
    writeFileSync(sessionJsonPath, JSON.stringify(metadata), "utf8");
  }

  // 3. Rewrite events.jsonl: replace `session_id` in each event line.
  const eventsPath = path.join(destDir, "events.jsonl");
  if (existsSync(eventsPath)) {
    const content = readFileSync(eventsPath, "utf8");
    // Use string replacement for performance (avoids JSON parse per line for
    // potentially large event logs). The session_id is always a UUID literal
    // appearing as a JSON string value, so a simple global replace is safe.
    const rewritten = content.replaceAll(`"session_id":"${sourceId}"`, `"session_id":"${newId}"`);
    writeFileSync(eventsPath, rewritten, "utf8");
  }

  // 4. Rewrite traces.jsonl: replace telemetry.session.id tag values.
  const tracesPath = path.join(destDir, "traces.jsonl");
  if (existsSync(tracesPath)) {
    const content = readFileSync(tracesPath, "utf8");
    // telemetry.session.id appears as a tag value in the Jaeger-style trace
    // format: {"key":"telemetry.session.id","type":"string","value":"<uuid>"}
    const rewritten = content.replaceAll(
      `"telemetry.session.id","type":"string","value":"${sourceId}"`,
      `"telemetry.session.id","type":"string","value":"${newId}"`,
    );
    writeFileSync(tracesPath, rewritten, "utf8");
  }

  return newId;
}
