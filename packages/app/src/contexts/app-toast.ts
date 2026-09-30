import type { ToastApi } from "@/components/toast-host";

// The app shell mounts one ToastProvider. Code that fires outside React — plugin command
// callbacks, stores — reaches that toast through here instead of threading the API down.
let current: ToastApi | null = null;

export function setAppToastApi(api: ToastApi | null): void {
  current = api;
}

/** Null before the app shell mounts, so callers must tolerate a dropped message. */
export function getAppToastApi(): ToastApi | null {
  return current;
}
