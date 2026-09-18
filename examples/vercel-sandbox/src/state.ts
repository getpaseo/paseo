import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { redactText } from "./providers.js";
import type { SessionState } from "./types.js";

const STATE_DIR = process.env.PASEO_SANDBOX_STATE_DIR
  ? join(process.env.PASEO_SANDBOX_STATE_DIR, "sessions")
  : join(process.env.HOME ?? process.cwd(), ".paseo-vercel-sandbox", "sessions");
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateSessionId(id: string): string {
  if (!SESSION_ID.test(id)) throw new Error(`invalid session id: ${id}`);
  return id;
}

export function stateDirectory(): string {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  return STATE_DIR;
}

export function statePath(id: string): string {
  return join(stateDirectory(), `${validateSessionId(id)}.json`);
}

export function newState(options: {
  name?: string;
  region: string;
  image: string;
  teamId: string;
  projectId: string;
  agentProvider: string;
  agentModel: string;
  repoUrl?: string;
  workspacePath: string;
  repoPath: string;
  paseoHome: string;
}): SessionState {
  const id = randomUUID();
  const now = new Date().toISOString();
  const name = options.name ?? `paseo-sandbox-${id}`;
  return {
    id,
    name,
    createdAt: now,
    updatedAt: now,
    phase: "intent",
    sandboxName: name,
    region: options.region,
    image: options.image,
    teamId: options.teamId,
    projectId: options.projectId,
    owner: randomUUID(),
    paseoHome: options.paseoHome,
    workspacePath: options.workspacePath,
    repoPath: options.repoPath,
    repoUrl: options.repoUrl,
    agentProvider: options.agentProvider,
    agentModel: options.agentModel,
    sessionIds: [],
    snapshotIds: [],
    snapshots: [],
    logs: [],
  };
}

export function loadState(id: string): SessionState {
  validateSessionId(id);
  const path = statePath(id);
  if (!existsSync(path)) throw new Error(`No session state for ${id} at ${path}`);
  const raw = JSON.parse(readFileSync(path, "utf8")) as SessionState;
  if (raw.id !== id) throw new Error(`session state identity mismatch for ${id}`);
  return { ...raw, snapshots: Array.isArray(raw.snapshots) ? raw.snapshots : [] };
}

export function saveState(state: SessionState): SessionState {
  validateSessionId(state.id);
  state.updatedAt = new Date().toISOString();
  const path = statePath(state.id);
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
  return state;
}

export function addLog(state: SessionState, message: string): SessionState {
  state.logs.push(`${new Date().toISOString()} ${message}`);
  return state;
}

export async function trackProvision<T>(
  state: SessionState,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const message = redactText(String(error));
    state.phase = "failed";
    state.lastError = message;
    saveState(state);
    // oxlint-disable-next-line preserve-caught-error -- Original errors can contain credentials.
    throw new Error(
      `${message}\nTo remove retained resources, run: paseo-sandbox destroy ${state.id}`,
    );
  }
}
