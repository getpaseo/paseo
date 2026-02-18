export type TauriNotificationPermission = "granted" | "denied" | "default";

export interface TauriDialogAskOptions {
  title?: string;
  okLabel?: string;
  cancelLabel?: string;
  kind?: "info" | "warning" | "error";
}

export interface TauriDialogApi {
  ask?: (message: string, options?: TauriDialogAskOptions) => Promise<boolean>;
}

export interface TauriCoreApi {
  invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  convertFileSrc?: (path: string) => string;
}

export interface TauriEventApi {
  listen?: (
    event: string,
    handler: (event: unknown) => void
  ) => Promise<() => void> | (() => void);
}

export interface TauriWindowApi {
  label?: string;
  startDragging?: () => Promise<void>;
  toggleMaximize?: () => Promise<void>;
  isFullscreen?: () => Promise<boolean>;
  onResized?: <TEvent = unknown>(
    handler: (event: TEvent) => void
  ) => Promise<() => void> | (() => void);
  setBadgeCount?: (count?: number) => Promise<void>;
  onDragDropEvent?: <TEvent = unknown>(
    handler: (event: TEvent) => void
  ) => Promise<() => void> | (() => void);
}

export interface TauriWindowModule {
  getCurrentWindow?: () => TauriWindowApi;
}

export interface TauriOpenerApi {
  openUrl?: (url: string) => Promise<void>;
}

export interface TauriNotificationApi {
  isPermissionGranted?: () => Promise<boolean>;
  requestPermission?: () => Promise<TauriNotificationPermission>;
  sendNotification?: (
    payload: string | { title: string; body?: string }
  ) => Promise<void>;
}

export interface TauriWebSocketApi {
  connect?: (url: string, config?: unknown) => Promise<unknown>;
}

export interface TauriApi {
  core?: TauriCoreApi;
  dialog?: TauriDialogApi;
  event?: TauriEventApi;
  notification?: TauriNotificationApi;
  opener?: TauriOpenerApi;
  websocket?: TauriWebSocketApi;
  window?: TauriWindowModule;
}

export function getTauri(): TauriApi | null {
  const tauri = (globalThis as { __TAURI__?: unknown }).__TAURI__;
  if (!tauri || typeof tauri !== "object") {
    return null;
  }
  return tauri as TauriApi;
}

export function isTauriEnvironment(): boolean {
  return getTauri() !== null;
}

export function getCurrentTauriWindow(): TauriWindowApi | null {
  const getter = getTauri()?.window?.getCurrentWindow;
  if (typeof getter !== "function") {
    return null;
  }
  try {
    return getter() ?? null;
  } catch {
    return null;
  }
}
