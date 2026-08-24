import { useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { getIsAppActivelyVisible, getIsAppVisible } from "@/utils/app-visibility";
import { isWeb } from "@/constants/platform";

let visible = getIsAppVisible();
let activelyVisible = getIsAppActivelyVisible();
const visibilityListeners = new Set<() => void>();
const activeVisibilityListeners = new Set<() => void>();

function notify(): void {
  const nextVisible = getIsAppVisible();
  if (nextVisible !== visible) {
    visible = nextVisible;
    for (const listener of visibilityListeners) listener();
  }

  const nextActivelyVisible = getIsAppActivelyVisible();
  if (nextActivelyVisible !== activelyVisible) {
    activelyVisible = nextActivelyVisible;
    for (const listener of activeVisibilityListeners) listener();
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

function subscribeToVisibility(listener: () => void): () => void {
  visibilityListeners.add(listener);
  return () => visibilityListeners.delete(listener);
}

function subscribeToActiveVisibility(listener: () => void): () => void {
  activeVisibilityListeners.add(listener);
  return () => activeVisibilityListeners.delete(listener);
}

function getVisibilitySnapshot(): boolean {
  return visible;
}

function getActiveVisibilitySnapshot(): boolean {
  return activelyVisible;
}

export function useAppVisible(): boolean {
  return useSyncExternalStore(subscribeToVisibility, getVisibilitySnapshot, getVisibilitySnapshot);
}

export function useAppActivelyVisible(): boolean {
  return useSyncExternalStore(
    subscribeToActiveVisibility,
    getActiveVisibilitySnapshot,
    getActiveVisibilitySnapshot,
  );
}
