import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

/**
 * Best-effort reads of Grok Build child-session metadata from the local
 * Grok home. All paths are private Grok layout; failures must be silent.
 */

const GrokChildSessionSummarySchema = z
  .object({
    current_model_id: z.string().optional(),
    reasoning_effort: z.string().optional(),
  })
  .passthrough();

export interface GrokSubagentDiskMeta {
  model: string | null;
  thinkingOptionId: string | null;
}

export function resolveGrokHome(env: Record<string, string | undefined> = process.env): string {
  return env.GROK_HOME?.trim() || join(homedir(), ".grok");
}

/** Match Grok's short-path `encode_cwd_dirname` (urlencoding of the cwd). */
export function encodeGrokSessionsCwdDirname(cwd: string): string {
  return encodeURIComponent(cwd);
}

function normalizeReasoningEffort(
  value: string | null | undefined,
  canonical: Record<string, string>,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return canonical[trimmed.toLowerCase()] ?? trimmed;
}

function readSummaryAt(
  path: string,
  canonical: Record<string, string>,
): GrokSubagentDiskMeta | null {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = GrokChildSessionSummarySchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    const model =
      typeof parsed.data.current_model_id === "string" && parsed.data.current_model_id.trim()
        ? parsed.data.current_model_id.trim()
        : null;
    const thinkingOptionId = normalizeReasoningEffort(parsed.data.reasoning_effort, canonical);
    if (!model && !thinkingOptionId) return null;
    return { model, thinkingOptionId };
  } catch {
    return null;
  }
}

/**
 * Locate `summary.json` for a Grok child session under `~/.grok/sessions`.
 * Prefer the direct cwd-encoded path; fall back to a shallow walk so long-cwd
 * hash encodings and layout drift still work when possible.
 */
export function readGrokSubagentDiskMeta(input: {
  childSessionId: string;
  cwd?: string | null;
  env?: Record<string, string | undefined>;
  canonicalReasoningEffort?: Record<string, string>;
}): GrokSubagentDiskMeta | null {
  const childSessionId = input.childSessionId.trim();
  if (!childSessionId) return null;

  const env = input.env ?? process.env;
  const grokHome = resolveGrokHome(env);
  const sessionsRoot = join(grokHome, "sessions");
  const canonical = input.canonicalReasoningEffort ?? {};

  const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
  if (cwd) {
    const direct = join(
      sessionsRoot,
      encodeGrokSessionsCwdDirname(cwd),
      childSessionId,
      "summary.json",
    );
    const fromDirect = readSummaryAt(direct, canonical);
    if (fromDirect) return fromDirect;
  }

  // Shallow walk: sessions/<cwd-epoch>/<session-id>/summary.json
  try {
    for (const epoch of readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!epoch.isDirectory()) continue;
      const candidate = join(sessionsRoot, epoch.name, childSessionId, "summary.json");
      const found = readSummaryAt(candidate, canonical);
      if (found) return found;
    }
  } catch {
    // missing sessions root or unreadable — graceful fail
  }
  return null;
}
