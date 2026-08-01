/**
 * Projection of the phone's Live Voice runtime into the wrist-sized state the
 * watch renders. Pure, so it is testable without a runtime or a Data Layer.
 */

import type { LiveVoiceAvailability } from "@/live-voice/live-voice-availability-policy";
import type { LiveVoiceSnapshot } from "@/live-voice/live-voice-runtime";
import {
  WEAR_PROTOCOL_VERSION,
  type WearLiveVoiceHost,
  type WearLiveVoiceState,
  type WearLiveVoiceTranscriptEntry,
} from "./wear-protocol";

/**
 * Transcript entries kept on the wrist.
 *
 * The phone retains 200; a round 450px display shows three or four at a time and
 * nobody scrolls a call back further than a few turns. Everything past this is
 * bytes over Bluetooth for content that will never be read.
 */
export const MAX_LIVE_VOICE_TRANSCRIPTS = 12;

/**
 * Per-entry character cap.
 *
 * An assistant turn can be several paragraphs. The watch wraps rather than
 * truncating, so an uncapped entry would push everything else off the screen and
 * cost proportionally on the wire.
 */
export const MAX_LIVE_VOICE_TRANSCRIPT_CHARS = 240;

export interface WearLiveVoiceInput {
  snapshot: LiveVoiceSnapshot;
  availability: LiveVoiceAvailability;
}

/**
 * Collapse whitespace and cap, the same treatment agent transcripts get: the
 * watch renders what arrives verbatim and does no text processing of its own.
 */
function projectText(text: string): string {
  const collapsed = text.replaceAll(/\s+/gu, " ").trim();
  return collapsed.length > MAX_LIVE_VOICE_TRANSCRIPT_CHARS
    ? `${collapsed.slice(0, MAX_LIVE_VOICE_TRANSCRIPT_CHARS - 1).trimEnd()}…`
    : collapsed;
}

function projectTranscripts(snapshot: LiveVoiceSnapshot): WearLiveVoiceTranscriptEntry[] {
  const entries: WearLiveVoiceTranscriptEntry[] = [];
  for (const entry of snapshot.transcripts.slice(-MAX_LIVE_VOICE_TRANSCRIPTS)) {
    const text = projectText(entry.text);
    // A transcript id with no words yet is a placeholder the model is still
    // filling in; it would render as an empty bubble.
    if (text.length === 0) continue;
    entries.push({ id: entry.id, role: entry.role, text });
  }
  return entries;
}

function projectHosts(availability: LiveVoiceAvailability): WearLiveVoiceHost[] {
  if (availability.kind !== "available") return [];
  return availability.hosts.map((host) => ({ serverId: host.serverId, label: host.label }));
}

/**
 * The label for the host a call is on.
 *
 * Resolved against the full host list rather than the callable subset: a host
 * stops being callable the moment it goes offline, and a live call's header
 * should still say which machine it was placed on.
 */
function resolveHostLabel(
  serverId: string | null,
  availability: LiveVoiceAvailability,
): string | null {
  if (!serverId) return null;
  return availability.hosts.find((host) => host.serverId === serverId)?.label ?? null;
}

export function buildWearLiveVoiceState(
  input: WearLiveVoiceInput,
  now: number,
): WearLiveVoiceState {
  const { snapshot, availability } = input;
  return {
    v: WEAR_PROTOCOL_VERSION,
    updatedAt: now,
    phase: snapshot.phase,
    serverId: snapshot.serverId,
    hostLabel: resolveHostLabel(snapshot.serverId, availability),
    isMuted: snapshot.isMuted,
    hosts: projectHosts(availability),
    unavailableReason: availability.kind === "unavailable" ? availability.reason : null,
    transcripts: projectTranscripts(snapshot),
    errorCode: snapshot.error?.code ?? null,
    errorMessage: snapshot.error?.message ?? null,
    closedCause: snapshot.closedCause,
  };
}

/**
 * Identity key for change detection, mirroring the snapshot path's. Excludes
 * `updatedAt`, which moves on every build and would defeat the comparison.
 */
export function stableLiveVoiceKey(state: WearLiveVoiceState): string {
  const { updatedAt: _updatedAt, ...rest } = state;
  return JSON.stringify(rest);
}
