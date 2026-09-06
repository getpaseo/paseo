/**
 * iOS/Android Live Voice cue playback.
 *
 * The cue is rendered from `live-voice-cue-tones` into a WAV in the cache
 * directory at provider mount, then played by `expo-audio`. Two constraints
 * shaped this:
 *
 *   - The shared voice `AudioEngine` (`@getpaseo/expo-two-way-audio`) owns the
 *     microphone, which is exactly what a Live Voice call has taken a lease on.
 *     Playing a cue through it would fight the call for the mic.
 *   - This module never calls `setAudioModeAsync`. WebRTC has already put the
 *     session in voice-chat mode for the call; changing it to play a 200 ms cue
 *     would interrupt the assistant's speech.
 *
 * A short haptic accompanies each cue so the transition is still perceptible
 * with the ringer off or with the phone away from the ear.
 */

import { createAudioPlayer, type AudioPlayer } from "expo-audio";
import { Directory, File, Paths } from "expo-file-system";
import * as Haptics from "expo-haptics";
import {
  LIVE_VOICE_CUES,
  LIVE_VOICE_CUE_SAMPLE_RATE,
  renderLiveVoiceCue,
  toPcm16,
  type LiveVoiceCue,
} from "@/live-voice/live-voice-cue-tones";
import type { LiveVoiceCuePlayer } from "@/live-voice/live-voice-cue-player";
import { encodePcm16Wav } from "@/utils/pcm16-wav";

export type { LiveVoiceCue } from "@/live-voice/live-voice-cue-tones";
export type { LiveVoiceCuePlayer } from "@/live-voice/live-voice-cue-player";

/** Under the call's own output: the cue marks a transition, it doesn't announce one. */
const CUE_VOLUME = 0.55;

const CUE_DIRECTORY_NAME = "live-voice-cues";

const CUE_HAPTIC: Record<LiveVoiceCue, Haptics.ImpactFeedbackStyle> = {
  connected: Haptics.ImpactFeedbackStyle.Light,
  disconnected: Haptics.ImpactFeedbackStyle.Soft,
};

function writeCueFile(directory: Directory, cue: LiveVoiceCue): File {
  const file = new File(directory, `${cue}.wav`);
  // Always rewrite: the bytes come from the tone spec, so a file left by an
  // older build would play the previous version of the cue forever.
  if (file.exists) {
    file.delete();
  }
  file.create({ intermediates: true });
  file.write(
    encodePcm16Wav({
      sampleRate: LIVE_VOICE_CUE_SAMPLE_RATE,
      samples: toPcm16(renderLiveVoiceCue(cue)),
    }),
  );
  return file;
}

export function createLiveVoiceCuePlayer(): LiveVoiceCuePlayer {
  const players = new Map<LiveVoiceCue, AudioPlayer>();
  let disposed = false;

  // Prepared once at provider mount so the first cue does not wait on file I/O.
  const ready = (async () => {
    const directory = new Directory(Paths.cache, CUE_DIRECTORY_NAME);
    if (!directory.exists) {
      directory.create({ intermediates: true });
    }
    for (const cue of LIVE_VOICE_CUES) {
      if (disposed) {
        return;
      }
      const file = writeCueFile(directory, cue);
      const player = createAudioPlayer({ uri: file.uri });
      player.volume = CUE_VOLUME;
      players.set(cue, player);
    }
  })().catch((error: unknown) => {
    console.warn("[LiveVoice] Failed to prepare call cues", error);
  });

  function playPrepared(cue: LiveVoiceCue): void {
    const player = players.get(cue);
    if (!player || disposed) {
      return;
    }
    try {
      // Cues can repeat within one app run, and a finished player sits at its
      // end position; rewind before every play.
      void player.seekTo(0).catch(() => undefined);
      player.play();
    } catch (error) {
      console.warn("[LiveVoice] Failed to play call cue", error);
    }
  }

  return {
    play(cue) {
      void Haptics.impactAsync(CUE_HAPTIC[cue]).catch(() => undefined);
      if (players.has(cue)) {
        playPrepared(cue);
        return;
      }
      // Preparation is still in flight (or already failed); play when it lands.
      void ready.then(() => playPrepared(cue));
    },

    dispose() {
      disposed = true;
      for (const player of players.values()) {
        try {
          player.remove();
        } catch {
          // Already released.
        }
      }
      players.clear();
    },
  };
}
