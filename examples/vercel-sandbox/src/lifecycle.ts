import { randomUUID } from "node:crypto";
import { Sandbox, Snapshot } from "@vercel/sandbox";
import type { VercelCredentials } from "./auth.js";
import type { SessionState, SnapshotRecord } from "./types.js";

export const DEFAULT_IMAGE = "vercel/sandbox/node:24";
export const DEFAULT_REGION = "iad1";
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export function newSandboxName(prefix = "paseo-sandbox"): string {
  return `${prefix}-${randomUUID()}`;
}

export function sandboxTags(state: SessionState): Record<string, string> {
  return {
    paseoSandbox: state.name,
    owner: state.owner,
  };
}

export function verifySandboxOwnership(sandbox: Sandbox, state: SessionState): void {
  if (
    sandbox.name !== state.sandboxName ||
    sandbox.tags?.paseoSandbox !== state.name ||
    sandbox.tags?.owner !== state.owner
  ) {
    throw new Error("sandbox owner or name mismatch");
  }
}

export function recordVerifiedSession(sandbox: Sandbox, state: SessionState): string {
  const sessionId = sandbox.currentSession().sessionId;
  if (!state.sessionIds.includes(sessionId)) state.sessionIds.push(sessionId);
  return sessionId;
}

export async function createSandbox(
  creds: VercelCredentials,
  state: SessionState,
): Promise<Sandbox> {
  return Sandbox.create({
    ...creds,
    name: state.sandboxName,
    image: state.image,
    region: state.region,
    timeout: DEFAULT_TIMEOUT_MS,
    persistent: true,
    snapshotExpiration: 24 * 60 * 60 * 1000,
    keepLastSnapshots: { count: 3 },
    tags: sandboxTags(state),
  });
}

export async function getSandbox(
  creds: VercelCredentials,
  state: SessionState,
  resume = false,
): Promise<Sandbox> {
  const sandbox = await Sandbox.get({ ...creds, name: state.sandboxName, resume: false });
  verifySandboxOwnership(sandbox, state);
  recordVerifiedSession(sandbox, state);
  if (resume) {
    await resumeSandbox(sandbox);
    recordVerifiedSession(sandbox, state);
  }
  return sandbox;
}

export async function stopSandbox(sandbox: Sandbox): Promise<SnapshotRecord | undefined> {
  const sourceSessionId = sandbox.currentSession().sessionId;
  const result = await sandbox.stop();
  if (!result.snapshot?.id) return undefined;
  return {
    id: result.snapshot.id,
    sourceSessionId,
  };
}

export function assertSandboxCanResume(sandbox: Pick<Sandbox, "status">): void {
  if (!["stopped", "stopping", "snapshotting"].includes(sandbox.status)) {
    throw new Error("Stop the sandbox after active work completes before resuming it.");
  }
}

export async function resumeSandbox(sandbox: Sandbox): Promise<void> {
  assertSandboxCanResume(sandbox);
  const result = await sandbox.runCommand("true", [], { timeoutMs: 60_000 });
  if (result.exitCode !== 0) throw new Error("sandbox resume probe failed");
}

export async function destroySandbox(sandbox: Sandbox): Promise<void> {
  await sandbox.delete();
}

export function isNotFound(error: unknown): boolean {
  const e = error as { response?: { status?: number } };
  return e?.response?.status === 404;
}

export async function listOwnedSandboxes(
  creds: VercelCredentials,
  state: SessionState,
): Promise<string[]> {
  const names: string[] = [];
  const result = await Sandbox.list({ ...creds, namePrefix: state.sandboxName, sortBy: "name" });
  for await (const sandbox of result) {
    if (sandbox.tags?.owner === state.owner) names.push(sandbox.name);
  }
  return names;
}

function addSnapshotRecord(state: SessionState, record: SnapshotRecord): void {
  if (!state.snapshots.some((candidate) => candidate.id === record.id))
    state.snapshots.push(record);
  if (!state.snapshotIds.includes(record.id)) state.snapshotIds.push(record.id);
}

export async function collectOwnedSnapshotCleanup(
  sandbox: Sandbox,
  state: SessionState,
): Promise<SnapshotRecord[]> {
  const sessions = await sandbox.listSessions();
  for await (const session of sessions) {
    if (!state.sessionIds.includes(session.id)) state.sessionIds.push(session.id);
  }
  const snapshots = await sandbox.listSnapshots();
  for await (const snapshot of snapshots) {
    if (!state.sessionIds.includes(snapshot.sourceSessionId)) {
      throw new Error(`snapshot ${snapshot.id} has no verified provenance`);
    }
    addSnapshotRecord(state, {
      id: snapshot.id,
      sourceSessionId: snapshot.sourceSessionId,
    });
  }
  return state.snapshots;
}

export async function listSnapshotsForSandbox(
  creds: VercelCredentials,
  state: SessionState,
): Promise<SnapshotRecord[]> {
  const sandbox = await getSandbox(creds, state, false);
  return collectOwnedSnapshotCleanup(sandbox, state);
}

export async function deleteVerifiedSnapshot(
  creds: VercelCredentials,
  state: SessionState,
  record: SnapshotRecord,
): Promise<void> {
  if (!state.sessionIds.includes(record.sourceSessionId)) {
    throw new Error(`snapshot ${record.id} has no verified provenance`);
  }
  const snapshot = await Snapshot.get({ ...creds, snapshotId: record.id });
  if (snapshot.sourceSessionId !== record.sourceSessionId) {
    throw new Error(`snapshot ${record.id} has no verified provenance`);
  }
  await snapshot.delete();
}

export async function destroySandboxAndSnapshots(
  creds: VercelCredentials,
  state: SessionState,
  persist: (state: SessionState) => void,
): Promise<string[]> {
  try {
    const sandbox = await getSandbox(creds, state, false);
    await collectOwnedSnapshotCleanup(sandbox, state);
    persist(state);
    await sandbox.delete();
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  for (const id of state.snapshotIds) {
    if (!state.snapshots.some((record) => record.id === id)) {
      throw new Error(`snapshot ${id} has no verified provenance`);
    }
  }
  persist(state);
  const deleted: string[] = [];
  for (const record of state.snapshots.slice()) {
    try {
      await deleteVerifiedSnapshot(creds, state, record);
      deleted.push(record.id);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      deleted.push(record.id);
    }
  }

  let absent = false;
  try {
    await getSandbox(creds, state, false);
  } catch (error) {
    if (isNotFound(error)) absent = true;
    else throw error;
  }
  if (!absent) throw new Error("sandbox still exists after delete");
  const remaining = await listRemainingSnapshots(creds, state);
  if (remaining.length) throw new Error(`snapshots remain after delete: ${remaining.join(", ")}`);

  state.snapshots = state.snapshots.filter((record) => !deleted.includes(record.id));
  state.snapshotIds = state.snapshotIds.filter((id) => !deleted.includes(id));
  persist(state);
  return deleted;
}

export async function listRemainingSnapshots(
  creds: VercelCredentials,
  state: SessionState,
): Promise<string[]> {
  const remaining: string[] = [];
  for (const record of state.snapshots) {
    try {
      const snapshot = await Snapshot.get({ ...creds, snapshotId: record.id });
      if (snapshot.sourceSessionId !== record.sourceSessionId) {
        throw new Error(`snapshot ${record.id} has no verified provenance`);
      }
      if (snapshot.status !== "deleted") remaining.push(record.id);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  return remaining;
}
