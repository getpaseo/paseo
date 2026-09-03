/**
 * The phone <-> watch wire contract.
 *
 * Mirrored by packages/watch/app/src/main/java/sh/paseo/watch/data/WearBridge.kt.
 * There is no codegen keeping them in sync; the watch has unit tests
 * (WearBridgeTest.kt) that pin this exact JSON shape, so a change here should make
 * those fail.
 *
 * This is a private protocol between two halves of one product, so it is NOT bound
 * by the daemon protocol's back-compat rules in CLAUDE.md. It does carry a version:
 * the user can update phone and watch independently, and a mismatch must be
 * detectable rather than silently mis-parsed. The watch drops any snapshot whose
 * version it doesn't recognise and shows its "update your phone app" state.
 */
export const WEAR_PROTOCOL_VERSION = 1;

/** Sentinel the native listener service sends when the watch asks for a republish. */
export const WEAR_REFRESH_SENTINEL = "refresh";

export type WearAgentState = "needsInput" | "running" | "idle";

export interface WearPermission {
  id: string;
  /** Short question, e.g. "Run command?". */
  title: string;
  /** The thing being approved; rendered monospace on the watch. */
  detail: string;
}

export interface WearAgent {
  id: string;
  /** Provider display name — the agent row's primary line on the watch. */
  provider: string;
  state: WearAgentState;
  /** Pre-formatted ("12m", "2h"). The watch does no clock math. */
  age: string;
  intent?: string;
  /**
   * One-line description of what the session is doing — the daemon's agent title.
   * Deliberately NOT the transcript tail: that would mean subscribing to every
   * agent's timeline just to populate a wrist.
   */
  summary?: string;
  permission?: WearPermission;
}

export interface WearWorkspace {
  id: string;
  /** Workspace name — the mnemonic for worktree-backed workspaces. */
  name: string;
  projectKey: string;
  projectName: string;
  /** Which daemon this lives on, so the watch can route commands back. */
  serverId: string;
  agents: WearAgent[];
}

export interface WearSnapshot {
  v: number;
  updatedAt: number;
  workspaces: WearWorkspace[];
}

/**
 * Transcript entry kinds the phone emits.
 *
 * The watch tolerates kinds it doesn't know so this list can grow without a
 * version bump; the phone must still only emit these four.
 */
export type WearTranscriptEntryKind = "user" | "assistant" | "tool" | "error";

export interface WearTranscriptEntry {
  kind: WearTranscriptEntryKind;
  /** Already trimmed, collapsed and capped — the watch renders it verbatim. */
  text: string;
}

/**
 * One agent's conversation, published on demand to `/paseo/transcript/<agentId>`.
 *
 * Deliberately not part of the snapshot: the snapshot covers every agent on every
 * daemon, and carrying transcripts for all of them would mean subscribing to every
 * timeline just to populate a wrist. The watch asks for exactly the one it opened.
 */
export interface WearTranscript {
  v: number;
  agentId: string;
  serverId: string;
  updatedAt: number;
  /** Oldest to newest. */
  entries: WearTranscriptEntry[];
  /** True when history exists before the first entry, so the watch can say so. */
  truncated: boolean;
}

export type WearCommand =
  | { kind: "sendPrompt"; serverId: string; agentId: string; text: string }
  | { kind: "createAgent"; serverId: string; workspaceId: string; text: string }
  | {
      kind: "respondPermission";
      serverId: string;
      agentId: string;
      requestId: string;
      allow: boolean;
    }
  | { kind: "stopAgent"; serverId: string; agentId: string }
  | { kind: "requestTranscript"; serverId: string; agentId: string }
  | { kind: "refresh" };

function str(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function buildCommand(
  kind: string,
  serverId: string,
  record: Record<string, unknown>,
): WearCommand | null {
  const agentId = str(record, "agentId");
  const text = str(record, "text");

  switch (kind) {
    case "sendPrompt":
      return agentId && text ? { kind: "sendPrompt", serverId, agentId, text } : null;
    case "createAgent": {
      const workspaceId = str(record, "workspaceId");
      return workspaceId && text ? { kind: "createAgent", serverId, workspaceId, text } : null;
    }
    case "respondPermission": {
      const requestId = str(record, "requestId");
      // `allow` must be a real boolean. A truthy string is a protocol error, not
      // consent — this is the one field where guessing would approve something.
      if (!agentId || !requestId || typeof record.allow !== "boolean") return null;
      return { kind: "respondPermission", serverId, agentId, requestId, allow: record.allow };
    }
    case "stopAgent":
      return agentId ? { kind: "stopAgent", serverId, agentId } : null;
    case "requestTranscript":
      return agentId ? { kind: "requestTranscript", serverId, agentId } : null;
    default:
      return null;
  }
}

/**
 * Parse a command from the watch. Returns null for anything unrecognised rather
 * than throwing — this runs on a native event and must never take the app down.
 */
export function parseWearCommand(raw: string): WearCommand | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;

  const kind = record.kind;
  if (typeof kind !== "string") return null;
  if (kind === "refresh") return { kind: "refresh" };

  // Every other command must come from a protocol version we speak.
  if (record.v !== undefined && record.v !== WEAR_PROTOCOL_VERSION) return null;

  const serverId = str(record, "serverId");
  if (!serverId) return null;

  return buildCommand(kind, serverId, record);
}
