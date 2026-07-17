import { useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { getIsAppActivelyVisible } from "@/utils/app-visibility";
import { isWeb } from "@/constants/platform";

let current = getIsAppActivelyVisible();
const listeners = new Set<() => void>();

function notify(): void {
  const next = getIsAppActivelyVisible();
  if (next === current) {
    return;
  }
  current = next;
  for (const listener of listeners) {
    listener();
  }
}

// Track visibility for the app's whole lifetime, not per consumer: transitions that happen while
// no consumer is mounted must still be reflected in the snapshot the next consumer reads, or a
// component mounting right after a focus change acts on stale visibility.
// AppState needs no environment guard of its own — react-native-web's implementation already
// no-ops when there is no DOM, unlike the raw document/window listeners below.
AppState.addEventListener("change", notify);
if (isWeb && typeof document !== "undefined") {
  document.addEventListener("visibilitychange", notify);
  window.addEventListener("focus", notify);
  window.addEventListener("blur", notify);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): boolean {
  return current;
}

export function useAppVisible(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
