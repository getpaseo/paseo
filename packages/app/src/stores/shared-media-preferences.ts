/**
 * Camera/mic preferences for shared sessions. Two roles:
 *
 * 1. Session-scoped handoff — the pre-join modal (or auth-server landing page
 *    via query params) writes the current selection here so the floating
 *    video panel picks it up on first mount.
 *
 * 2. Persisted defaults — device IDs chosen by the user survive reloads so
 *    the next pre-join modal auto-selects the same camera/mic. Persisted via
 *    `localStorage` on web; on native (no storage here) defaults are in-memory
 *    only, which is fine because the native video flow uses the system picker.
 *
 * Enable/disable toggles are deliberately NOT persisted — starting with video
 * off "by default forever" is a surprise. Each pre-join session begins with
 * both toggles on and the user re-decides per join.
 */

import { useSyncExternalStore } from "react";

export interface SharedMediaPreferences {
  videoEnabled: boolean;
  audioEnabled: boolean;
  videoDeviceId: string | null;
  audioDeviceId: string | null;
}

const STORAGE_KEY = "hubcode_shared_media_defaults";

interface StoredDefaults {
  videoDeviceId: string | null;
  audioDeviceId: string | null;
}

function loadStoredDefaults(): StoredDefaults {
  try {
    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw) as Partial<StoredDefaults>;
        return {
          videoDeviceId: typeof data.videoDeviceId === "string" ? data.videoDeviceId : null,
          audioDeviceId: typeof data.audioDeviceId === "string" ? data.audioDeviceId : null,
        };
      }
    }
  } catch {
    /* ignore */
  }
  return { videoDeviceId: null, audioDeviceId: null };
}

function persistDefaults(defaults: StoredDefaults): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(defaults));
    }
  } catch {
    /* ignore */
  }
}

const storedDefaults = loadStoredDefaults();

let prefs: SharedMediaPreferences = {
  videoEnabled: true,
  audioEnabled: true,
  videoDeviceId: storedDefaults.videoDeviceId,
  audioDeviceId: storedDefaults.audioDeviceId,
};

const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function setSharedMediaPreferences(next: SharedMediaPreferences): void {
  const deviceIdsChanged =
    next.videoDeviceId !== prefs.videoDeviceId || next.audioDeviceId !== prefs.audioDeviceId;
  prefs = { ...next };
  if (deviceIdsChanged) {
    persistDefaults({
      videoDeviceId: next.videoDeviceId,
      audioDeviceId: next.audioDeviceId,
    });
  }
  emit();
}

/**
 * Persist device defaults without touching the enable/disable toggles. Used by
 * the pre-join modal on every dropdown change so the choice survives even if
 * the user cancels out of the modal.
 */
export function setSharedMediaDeviceDefaults(input: {
  videoDeviceId?: string | null;
  audioDeviceId?: string | null;
}): void {
  const nextVideoDeviceId =
    input.videoDeviceId !== undefined ? input.videoDeviceId : prefs.videoDeviceId;
  const nextAudioDeviceId =
    input.audioDeviceId !== undefined ? input.audioDeviceId : prefs.audioDeviceId;
  if (nextVideoDeviceId === prefs.videoDeviceId && nextAudioDeviceId === prefs.audioDeviceId) {
    return;
  }
  prefs = {
    ...prefs,
    videoDeviceId: nextVideoDeviceId,
    audioDeviceId: nextAudioDeviceId,
  };
  persistDefaults({
    videoDeviceId: nextVideoDeviceId,
    audioDeviceId: nextAudioDeviceId,
  });
  emit();
}

export function getSharedMediaPreferences(): SharedMediaPreferences {
  return prefs;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useSharedMediaPreferences(): SharedMediaPreferences {
  return useSyncExternalStore(subscribe, getSharedMediaPreferences, getSharedMediaPreferences);
}
