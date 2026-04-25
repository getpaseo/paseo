// Persists Hubcode-agent conversation history to disk so the chat survives
// daemon restarts and session reopens, the same way Claude/Codex sessions do.
//
// Hubcode proxies a stateless OpenAI-style `/v1/chat/completions`, so the
// upstream has no session state to resume from — the entire history lives
// in `HubcodeAgentSession.messages`. To match the persistence behavior of
// the other providers we serialize that array (plus a few bits of metadata)
// to `$HUBCODE_HOME/hubcode-sessions/<sessionId>.json` after every turn,
// and load it back in `resumeSession`.

import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveHubcodeHome } from "../../hubcode-home.js";

const SCHEMA_VERSION = 1;

export interface PersistedHubcodeSession {
  schemaVersion: number;
  sessionId: string;
  modeId: string;
  model?: string;
  /** OpenAI-shaped chat history. Kept opaque on purpose — the agent owns the type. */
  messages: unknown[];
  savedAt: string;
}

function sessionsDir(): string {
  return path.join(resolveHubcodeHome(), "hubcode-sessions");
}

function sessionPath(sessionId: string): string {
  return path.join(sessionsDir(), `${encodeURIComponent(sessionId)}.json`);
}

export async function loadHubcodeSession(
  sessionId: string,
): Promise<PersistedHubcodeSession | null> {
  try {
    const raw = await fs.readFile(sessionPath(sessionId), "utf8");
    const parsed = JSON.parse(raw) as PersistedHubcodeSession;
    if (parsed.schemaVersion !== SCHEMA_VERSION) return null;
    if (!Array.isArray(parsed.messages)) return null;
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function saveHubcodeSession(payload: {
  sessionId: string;
  modeId: string;
  model?: string;
  messages: unknown[];
}): Promise<void> {
  const dir = sessionsDir();
  await fs.mkdir(dir, { recursive: true });
  const record: PersistedHubcodeSession = {
    schemaVersion: SCHEMA_VERSION,
    sessionId: payload.sessionId,
    modeId: payload.modeId,
    model: payload.model,
    messages: payload.messages,
    savedAt: new Date().toISOString(),
  };
  // Atomic write: tmp + rename. A crash mid-write would otherwise leave a
  // truncated file that breaks the next load.
  const finalPath = sessionPath(payload.sessionId);
  const tmpPath = `${finalPath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(record), "utf8");
  await fs.rename(tmpPath, finalPath);
}
