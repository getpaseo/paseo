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

/**
 * Live Voice as the watch sees it.
 *
 * The call itself stays on the phone — the WebRTC peer and the daemon socket are
 * both phone-side, and the watch is a remote control for them. Where the audio
 * plays is decided separately, by the phone's communication-device routing, and
 * never travels over this protocol. See packages/watch/README.md.
 *
 * Published on its own DataItem path rather than folded into [WearSnapshot]: a
 * call emits transcript deltas continuously, and putting them in the snapshot
 * would rewrite the whole workspace list on every phrase.
 */
export type WearLiveVoicePhase = "idle" | "starting" | "active" | "stopping" | "error";

/** One host the watch may place a call on. */
export interface WearLiveVoiceHost {
  serverId: string;
  /** Host display label, already resolved by the phone. */
  label: string;
}

export interface WearLiveVoiceTranscriptEntry {
  id: string;
  role: "user" | "assistant";
  /** Already trimmed and capped — the watch renders it verbatim. */
  text: string;
}

export interface WearLiveVoiceState {
  v: number;
  updatedAt: number;
  phase: WearLiveVoicePhase;
  /** The host the current (or last) call is on. */
  serverId: string | null;
  /** That host's label, so the watch never has to join against the snapshot. */
  hostLabel: string | null;
  isMuted: boolean;
  /**
   * Hosts that can take a call right now. Empty means the watch shows why from
   * [unavailableReason] instead of offering a start button.
   */
  hosts: WearLiveVoiceHost[];
  /**
   * Why no host is callable, when `hosts` is empty. An open string: the phone's
   * reason set can grow, and the watch falls back to generic copy for anything
   * it doesn't recognise.
   */
  unavailableReason: string | null;
  /** Newest last, capped for a wrist. */
  transcripts: WearLiveVoiceTranscriptEntry[];
  errorCode: string | null;
  errorMessage: string | null;
  /** `cause` of the last close, so the watch can explain a call that ended. */
  closedCause: string | null;
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
  | { kind: "startLiveVoice"; serverId: string }
  | { kind: "stopLiveVoice" }
  | { kind: "toggleLiveVoiceMute" }
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

  // A Live Voice call is app-global — there is only ever one, and the runtime
  // already knows which host it is on. Requiring a serverId here would let a
  // watch holding a stale state item address a call that has since moved.
  if (kind === "stopLiveVoice") return { kind: "stopLiveVoice" };
  if (kind === "toggleLiveVoiceMute") return { kind: "toggleLiveVoiceMute" };

  const serverId = str(record, "serverId");
  if (!serverId) return null;

  // Starting is the one Live Voice command that names a host, because picking
  // which daemon answers is exactly what the watch is deciding.
  if (kind === "startLiveVoice") return { kind: "startLiveVoice", serverId };

  return buildCommand(kind, serverId, record);
}
