import { useSyncExternalStore } from "react";
import type { DaemonClient, ReadAloudHandle } from "@getpaseo/client";

import {
  isReadAloudAudioSupported,
  playReadAloudSegment,
  setReadAloudPlaybackRate,
  stopReadAloudAudio,
} from "@/read-aloud/read-aloud-audio";

/**
 * Selectable speeds.
 *
 * Capped at 2x because playback is a raw resampling rate on the shared voice
 * audio engine — pitch is not preserved, and past 2x the voice stops sounding
 * like a voice. 2x matches what podcast and article readers offer anyway.
 */
export const READ_ALOUD_RATES = [1, 1.5, 2] as const;

export type ReadAloudRate = (typeof READ_ALOUD_RATES)[number];

const DEFAULT_RATE: ReadAloudRate = 1;

export interface ReadAloudFailure {
  /** Daemon-side code (`tts_unavailable`, `text_too_long`, …) or a client code. */
  code: string;
  /** Raw daemon message, used only when the code has no translated copy. */
  message: string;
}

export interface ReadAloudSnapshot {
  /** `loading` = synthesizing, no audio yet. `speaking` = audio is playing. */
  status: "idle" | "loading" | "speaking";
  failure: ReadAloudFailure | null;
  rate: ReadAloudRate;
  /**
   * Who asked for this read — the assistant message id of the turn whose button
   * was pressed. Playback is a single module-level slot, but the button lives in
   * every turn footer, so a footer subscribing to this snapshot has to know
   * whether it is the one speaking or a bystander. `null` when idle.
   */
  ownerId: string | null;
}

/**
 * Outlives any single playback: picking 2x once should hold for the next
 * selection too, so it deliberately survives `stopReadAloud`.
 */
let playbackRate: ReadAloudRate = DEFAULT_RATE;

let snapshot: ReadAloudSnapshot = {
  status: "idle",
  failure: null,
  rate: playbackRate,
  ownerId: null,
};
const listeners = new Set<() => void>();

/**
 * Bumped by every start/stop so callbacks from a superseded request are ignored
 * instead of resurrecting state for audio the user already dismissed.
 */
let generation = 0;
let handle: ReadAloudHandle | null = null;
let pendingSegmentPlaybacks = 0;
let streamEnded = false;

/** The turn currently holding the playback slot. Cleared when playback ends. */
let ownerId: string | null = null;

// Takes everything but `rate` and `ownerId`: both are owned by module state, so
// folding them in here keeps every call site from having to carry them forward.
function setSnapshot(next: Omit<ReadAloudSnapshot, "rate" | "ownerId">): void {
  snapshot = { ...next, rate: playbackRate, ownerId };
  for (const listener of listeners) {
    listener();
  }
}

function finishIfDone(token: number): void {
  if (token !== generation) {
    return;
  }
  if (!streamEnded || pendingSegmentPlaybacks > 0) {
    return;
  }
  handle = null;
  ownerId = null;
  setSnapshot({ status: "idle", failure: snapshot.failure });
}

export function getReadAloudSnapshot(): ReadAloudSnapshot {
  return snapshot;
}

export function subscribeReadAloud(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useReadAloudSnapshot(): ReadAloudSnapshot {
  return useSyncExternalStore(subscribeReadAloud, getReadAloudSnapshot, getReadAloudSnapshot);
}

/** Stop playback and cancel daemon-side synthesis. Safe to call when idle. */
export function stopReadAloud(): void {
  generation += 1;
  handle?.cancel();
  handle = null;
  ownerId = null;
  pendingSegmentPlaybacks = 0;
  streamEnded = false;
  stopReadAloudAudio();
  setSnapshot({ status: "idle", failure: null });
}

/**
 * Change speed. Takes effect immediately on audio that is already playing, so
 * the user hears the result of the tap without restarting the selection.
 */
export function setReadAloudRate(rate: ReadAloudRate): void {
  if (rate === playbackRate) {
    return;
  }
  playbackRate = rate;
  setReadAloudPlaybackRate(rate);
  setSnapshot({ status: snapshot.status, failure: snapshot.failure });
}

export function startReadAloud(params: {
  client: DaemonClient;
  text: string;
  /** Assistant message id of the turn being read; surfaces as `snapshot.ownerId`. */
  ownerId: string;
}): void {
  stopReadAloud();

  if (!isReadAloudAudioSupported) {
    setSnapshot({
      status: "idle",
      failure: { code: "unsupported_platform", message: "Read aloud is not available here" },
    });
    return;
  }

  // Set after the guard above: a rejected start never takes the slot, so a
  // failure surfaces without a bystander footer rendering itself as the owner.
  ownerId = params.ownerId;

  // The engine is created lazily and defaults to 1x, so a rate chosen during an
  // earlier selection has to be re-applied rather than assumed to still be set.
  setReadAloudPlaybackRate(playbackRate);

  const token = generation;
  setSnapshot({ status: "loading", failure: null });

  handle = params.client.startReadAloud({
    text: params.text,
    onSegment: (segment) => {
      if (token !== generation) {
        return;
      }
      pendingSegmentPlaybacks += 1;
      if (snapshot.status === "loading") {
        setSnapshot({ status: "speaking", failure: null });
      }
      const settleSegment = (error?: unknown) => {
        if (token !== generation) {
          return;
        }
        pendingSegmentPlaybacks = Math.max(0, pendingSegmentPlaybacks - 1);
        // A stop is not a failure — `stopReadAloud` already bumped `generation`,
        // so anything reaching here is a genuine decode/playback problem. Report
        // it: silently swallowing meant a broken segment looked like success
        // with no audio, which is indistinguishable from "the feature is dead".
        if (error !== undefined) {
          setSnapshot({
            status: snapshot.status,
            failure: {
              code: "playback_failed",
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
        finishIfDone(token);
      };
      void playReadAloudSegment({
        audioBase64: segment.audioBase64,
        format: segment.format,
      }).then(
        () => settleSegment(),
        (error: unknown) => settleSegment(error ?? new Error("Playback failed")),
      );
    },
    onError: (error) => {
      if (token !== generation) {
        return;
      }
      setSnapshot({ status: snapshot.status, failure: { ...error } });
    },
    onEnd: () => {
      if (token !== generation) {
        return;
      }
      streamEnded = true;
      finishIfDone(token);
    },
  });
}
