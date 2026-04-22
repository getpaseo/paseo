import { useEffect, useSyncExternalStore } from "react";
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

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): boolean {
  return current;
}

export function useAppVisible(): boolean {
  useEffect(() => {
    const appStateSubscription = AppState.addEventListener("change", notify);

    if (isWeb && typeof document !== "undefined") {
      document.addEventListener("visibilitychange", notify);
      window.addEventListener("focus", notify);
      window.addEventListener("blur", notify);
    }

    return () => {
      appStateSubscription.remove();
      if (isWeb && typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", notify);
        window.removeEventListener("focus", notify);
        window.removeEventListener("blur", notify);
      }
    };
  }, []);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
