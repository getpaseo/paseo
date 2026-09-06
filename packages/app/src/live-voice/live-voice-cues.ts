/**
 * When the Live Voice call cues fire.
 *
 * The runtime publishes a new snapshot for every state change — mute, a
 * transcript line, an autoplay block — so "play a sound when the phase looks
 * connected" would chime constantly. The rule is edge-triggered instead, off a
 * single latch:
 *
 *   - `connected` fires on the first snapshot where the call is `active`.
 *   - `disconnected` fires on the first snapshot that leaves `active`, whatever
 *     the reason: the user stopping, a fatal error, the daemon closing the call,
 *     or the host connection dropping.
 *
 * Consequences worth stating, because they are the point:
 *   - A failed start (`starting` → `error`) plays nothing. The user never got a
 *     connect cue, so a disconnect cue would be a sound for an event that did
 *     not happen; the error UI carries that news.
 *   - `stop()` moves through `stopping` and then `idle`. Both leave `active`,
 *     but the latch has already cleared, so the cue plays once.
 *   - A non-fatal error keeps the call `active` and stays silent.
 *
 * The runtime has no reconnecting phase — a dropped transport is terminal — so
 * every edge out of `active` is a real end of call, not a transient blip.
 */

import {
  createLiveVoiceCuePlayer,
  type LiveVoiceCuePlayer,
} from "@/live-voice/live-voice-cue-player";
import type { LiveVoiceCue } from "@/live-voice/live-voice-cue-tones";
import type { LiveVoicePhase, LiveVoiceRuntime } from "@/live-voice/live-voice-runtime";

export type { LiveVoiceCue } from "@/live-voice/live-voice-cue-tones";

/** The latch. `true` while a connect cue has fired without its disconnect. */
export type LiveVoiceCueState = boolean;

export function initialLiveVoiceCueState(phase: LiveVoicePhase): LiveVoiceCueState {
  // Attaching to an already-live call must not chime; only a transition does.
  return phase === "active";
}

export function advanceLiveVoiceCueState(
  state: LiveVoiceCueState,
  phase: LiveVoicePhase,
): { state: LiveVoiceCueState; cue: LiveVoiceCue | null } {
  const isActive = phase === "active";
  if (isActive === state) {
    return { state, cue: null };
  }
  return { state: isActive, cue: isActive ? "connected" : "disconnected" };
}

/**
 * Subscribe cue playback to a runtime. Returns an unsubscribe that also
 * releases the player, so the provider's teardown silences pending cues rather
 * than chiming on its way out.
 */
export function attachLiveVoiceCues(
  runtime: LiveVoiceRuntime,
  player: LiveVoiceCuePlayer = createLiveVoiceCuePlayer(),
): () => void {
  let state = initialLiveVoiceCueState(runtime.getSnapshot().phase);

  const unsubscribe = runtime.subscribe(() => {
    const next = advanceLiveVoiceCueState(state, runtime.getSnapshot().phase);
    state = next.state;
    if (next.cue) {
      player.play(next.cue);
    }
  });

  return () => {
    unsubscribe();
    player.dispose();
  };
}
