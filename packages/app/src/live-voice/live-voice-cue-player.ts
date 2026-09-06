/**
 * Live Voice call cue playback — platform-neutral contract and silent fallback.
 *
 * Metro resolves `.web.ts` for browsers/Electron and `.native.ts` for iOS and
 * Android. Import via the base name (`@/live-voice/live-voice-cue-player`).
 *
 * A cue is fire-and-forget: `play` never throws and never returns a promise the
 * caller has to handle. A cue that cannot be played is not worth an error path —
 * the call itself is unaffected.
 */

import type { LiveVoiceCue } from "@/live-voice/live-voice-cue-tones";

export type { LiveVoiceCue } from "@/live-voice/live-voice-cue-tones";

export interface LiveVoiceCuePlayer {
  play(cue: LiveVoiceCue): void;
  dispose(): void;
}

export function createLiveVoiceCuePlayer(): LiveVoiceCuePlayer {
  return {
    play() {},
    dispose() {},
  };
}
