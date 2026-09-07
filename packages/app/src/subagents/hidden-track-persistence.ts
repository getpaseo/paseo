import type { StateStorage } from "zustand/middleware";
import { z } from "zod";
import { isWeb } from "@/constants/platform";

// The web build of @react-native-async-storage/async-storage reads window.localStorage
// unconditionally. On native it never runs (a separate native module resolves instead), and in
// a real browser window always exists; the only gap is a windowless web evaluation (SSR, or this
// package's Node-environment unit tests), where calling it would throw. Fall back to a no-op
// there so hydration silently skips instead of crashing.
export function resolveHiddenTrackStorage(asyncStorage: StateStorage): StateStorage {
  if (isWeb && typeof window === "undefined") {
    return {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    };
  }
  return asyncStorage;
}

export interface PersistedHiddenProviderSubagents {
  hiddenFromTrack?: string[];
}

export const PersistedHiddenProviderSubagentsSchema: z.ZodType<PersistedHiddenProviderSubagents> =
  z.strictObject({
    hiddenFromTrack: z.array(z.string()).optional(),
  });

export function serializeHiddenFromTrack(hiddenFromTrack: Set<string>): {
  hiddenFromTrack: string[];
} {
  return { hiddenFromTrack: Array.from(hiddenFromTrack) };
}

export function mergeHiddenFromTrack<S extends { hiddenFromTrack: Set<string> }>(
  persistedValue: unknown,
  current: S,
): S {
  const result = PersistedHiddenProviderSubagentsSchema.safeParse(persistedValue);
  if (!result.success) {
    return current;
  }
  const restored = new Set(result.data.hiddenFromTrack ?? current.hiddenFromTrack);
  if (areSetsEqual(current.hiddenFromTrack, restored)) {
    return current;
  }
  return { ...current, hiddenFromTrack: restored };
}

function areSetsEqual(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const key of left) {
    if (!right.has(key)) {
      return false;
    }
  }
  return true;
}
