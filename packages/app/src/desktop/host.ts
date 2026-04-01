import { Platform } from "react-native";
import { getElectronHost } from "@/desktop/electron/host";

export type DesktopNotificationPermission = "granted" | "denied" | "default";

export interface DesktopDialogAskOptions {
  title?: string;
  okLabel?: string;
  cancelLabel?: string;
  kind?: "info" | "warning" | "error";
}

export interface DesktopDialogOpenOptions {
  title?: string;
  defaultPath?: string;
  directory?: boolean;
  multiple?: boolean;
  filters?: Array<{
    name: string;
    extensions: string[];
  }>;
}

export interface DesktopDialogBridge {
  ask?: (message: string, options?: DesktopDialogAskOptions) => Promise<boolean>;
  open?: (options?: DesktopDialogOpenOptions) => Promise<string | string[] | null>;
}

export interface DesktopNotificationBridge {
  isSupported?: () => Promise<boolean>;
  sendNotification?: (
    payload: string | { title: string; body?: string; data?: Record<string, unknown> },
  ) => Promise<boolean>;
}

export interface DesktopOpenerBridge {
  openUrl?: (url: string) => Promise<void>;
}

export interface DesktopMenuBridge {
  showContextMenu?: (input?: {
    kind?: "terminal";
    hasSelection?: boolean;
  }) => Promise<void>;
}

export interface DesktopWindowControlsOverlayUpdate {
  height?: number;
  backgroundColor?: string;
  foregroundColor?: string;
}

export interface DesktopWindowBridge {
  label?: string;
  toggleMaximize?: () => Promise<void>;
  isFullscreen?: () => Promise<boolean>;
  updateWindowControls?: (update: DesktopWindowControlsOverlayUpdate) => Promise<void>;
  onResized?: <TEvent = unknown>(
    handler: (event: TEvent) => void,
  ) => Promise<() => void> | (() => void);
  setBadgeCount?: (count?: number) => Promise<void>;
  onDragDropEvent?: <TEvent = unknown>(
    handler: (event: TEvent) => void,
  ) => Promise<() => void> | (() => void);
}

export interface DesktopWindowModuleBridge {
  getCurrentWindow?: () => DesktopWindowBridge;
}

export interface DesktopEventsBridge {
  on?: (event: string, handler: (payload: unknown) => void) => Promise<() => void> | (() => void);
}

export interface DesktopInvokeBridge {
  invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
}

export interface DesktopHostBridge {
  platform?: string;
  invoke?: DesktopInvokeBridge["invoke"];
  events?: DesktopEventsBridge;
  window?: DesktopWindowModuleBridge;
  dialog?: DesktopDialogBridge;
  notification?: DesktopNotificationBridge;
  opener?: DesktopOpenerBridge;
  menu?: DesktopMenuBridge;
}

declare global {
  interface Window {
    paseoDesktop?: DesktopHostBridge;
  }
}

export function getDesktopHost(): DesktopHostBridge | null {
  if (Platform.OS !== "web") {
    return null;
  }
  return getElectronHost();
}

export function isElectronRuntime(): boolean {
  return getDesktopHost() !== null;
}

export function isElectronRuntimeMac(): boolean {
  if (!isElectronRuntime()) {
    return false;
  }
  if (typeof navigator === "undefined") {
    return false;
  }
  const hostPlatform = getDesktopHost()?.platform?.toLowerCase();
  if (hostPlatform === "darwin" || hostPlatform === "mac" || hostPlatform === "macos") {
    return true;
  }
  const ua = navigator.userAgent;
  return ua.includes("Mac OS") || ua.includes("Macintosh");
}
