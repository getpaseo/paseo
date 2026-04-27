import type { DesktopHostBridge } from "@/desktop/host";

export function getElectronHost(): DesktopHostBridge | null {
  if (typeof window === "undefined") {
    return null;
  }
  const host = window.hubcodeDesktop;
  if (!host || typeof host !== "object") {
    return null;
  }
  return host;
}
