import { useEffect, useRef } from "react";
import { useSharedParticipants, useSharedSessionStore } from "@/stores/shared-session-store";

/**
 * Plays a short two-tone "ding" when a new participant joins the shared
 * session. Synthesized via Web Audio so we don't need to ship an audio asset.
 *
 * Quiet on the very first observation (initial roster) so we don't ring at
 * page load, and silent for the local user themselves.
 */
export function useJoinSound(): void {
  const participants = useSharedParticipants();
  const { currentUser } = useSharedSessionStore();
  const knownUserIdsRef = useRef<Set<string> | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    const liveUserIds = new Set<string>();
    for (const p of participants.values()) {
      if (p.userId) liveUserIds.add(p.userId);
    }

    // First observation after entering the session — seed the baseline
    // without ringing. Otherwise every page load would ding for everyone
    // already present.
    if (knownUserIdsRef.current === null) {
      knownUserIdsRef.current = liveUserIds;
      return;
    }

    const previous = knownUserIdsRef.current;
    const newcomers: string[] = [];
    for (const id of liveUserIds) {
      if (!previous.has(id) && id !== currentUser?.userId) newcomers.push(id);
    }
    knownUserIdsRef.current = liveUserIds;

    if (newcomers.length === 0) return;

    try {
      const Ctx =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtxRef.current) audioCtxRef.current = new Ctx();
      const ctx = audioCtxRef.current;
      // Browsers suspend new contexts until a user gesture. If still suspended
      // here, the ding silently no-ops — no error spam.
      if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);

      const now = ctx.currentTime;
      // Two ascending tones: 660Hz → 880Hz, 80ms each, soft attack/release.
      playTone(ctx, 660, now, 0.08);
      playTone(ctx, 880, now + 0.09, 0.08);
    } catch {
      // Audio is a nice-to-have; never let a broken context interrupt the UI.
    }
  }, [participants, currentUser?.userId]);
}

function playTone(ctx: AudioContext, freq: number, startAt: number, dur: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  // Quick attack, gentle release — sounds like a soft "ding" not a beep.
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(0.18, startAt + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + dur + 0.02);
}
