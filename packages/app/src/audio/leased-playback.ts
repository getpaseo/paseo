import {
  audioSessionLease,
  type AudioSessionLease,
  type AudioSessionLeaseToken,
} from "./audio-session-lease";
import { AudioCaptureBusyError } from "./capture-lifetime";
import type { AudioEngine, AudioPlaybackSource } from "@/voice/audio-engine-types";

const failedCleanup = new WeakMap<
  AudioEngine,
  { lease: AudioSessionLease; token: AudioSessionLeaseToken }
>();

function finishPlayback(engine: AudioEngine): void {
  const retained = failedCleanup.get(engine);
  if (!retained) return;
  engine.stop();
  failedCleanup.delete(engine);
  retained.lease.release(retained.token);
}

/** Standalone speech and diagnostics must not change another feature's OS audio session. */
export async function playAudioWithLease(
  engine: AudioEngine,
  audio: AudioPlaybackSource,
  lease: AudioSessionLease = audioSessionLease,
): Promise<number> {
  finishPlayback(engine);
  const token = lease.acquire("playback");
  if (!token) throw new AudioCaptureBusyError(lease.current());
  try {
    await engine.initialize();
    return await engine.play(audio);
  } finally {
    failedCleanup.set(engine, { lease, token });
    finishPlayback(engine);
  }
}
