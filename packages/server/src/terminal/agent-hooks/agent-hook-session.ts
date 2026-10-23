import type { AgentHookActivityInput } from "./agent-hook-installer.js";

export interface AgentHookPayload {
  session: { sessionId: string; cwd?: string } | null;
  fields: Record<string, unknown>;
}

// Claude and Codex both send the hook event as a JSON object on stdin with
// top-level `session_id` and `cwd`. Missing, malformed, or TTY input yields null so a hook
// without a payload still reports activity.
export async function readAgentHookPayload(
  input: AgentHookActivityInput,
): Promise<AgentHookPayload | null> {
  if (input.isTTY) return null;
  const raw = await input.read();
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const fields = parsed as Record<string, unknown>;
  const sessionId = nonEmptyString(fields.session_id);
  const cwd = nonEmptyString(fields.cwd);
  return { session: sessionId ? { sessionId, ...(cwd ? { cwd } : {}) } : null, fields };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
