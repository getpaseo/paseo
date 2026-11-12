import { useEffect, useMemo, useRef, useState } from "react";
import { getIsElectronRuntimeMac } from "@/constants/layout";
import { useAllDirectoryDemand } from "./use-directory-demand";
import { getDesktopHost } from "@/desktop/host";
import { createMacDockBadgeCountSelector } from "@/utils/desktop-badge-state";
import { createFaviconStatusSelector, type FaviconStatus } from "@/utils/favicon-status";
import { isNative } from "@/constants/platform";
import { useSessionStore } from "@/stores/session-store";
import { useHosts } from "@/runtime/host-runtime";

type ColorScheme = "dark" | "light";

/* eslint-disable @typescript-eslint/no-require-imports */
const FAVICON_IMAGES: Record<ColorScheme, Record<FaviconStatus, { uri: string } | number>> = {
  dark: {
    none: require("../../assets/images/favicon-dark.png"),
    running: require("../../assets/images/favicon-dark-running.png"),
    attention: require("../../assets/images/favicon-dark-attention.png"),
  },
  light: {
    none: require("../../assets/images/favicon-light.png"),
    running: require("../../assets/images/favicon-light-running.png"),
    attention: require("../../assets/images/favicon-light-attention.png"),
  },
};
/* eslint-enable @typescript-eslint/no-require-imports */

function getFaviconUri(status: FaviconStatus, colorScheme: ColorScheme): string {
  const image = FAVICON_IMAGES[colorScheme][status];
  if (typeof image === "object" && "uri" in image) {
    return image.uri;
  }
  const suffix = status === "none" ? "" : `-${status}`;
  return `/assets/images/favicon-${colorScheme}${suffix}.png`;
}

function getOrCreateFaviconLink(): HTMLLinkElement | null {
  if (typeof document === "undefined") return null;

  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    link.type = "image/png";
    document.head.appendChild(link);
  }
  return link;
}

function updateFavicon(status: FaviconStatus, colorScheme: ColorScheme) {
  const link = getOrCreateFaviconLink();
  if (!link) return;

  const newHref = getFaviconUri(status, colorScheme);
  if (link.href !== newHref) {
    link.href = newHref;
  }
}

function getSystemColorScheme(): ColorScheme {
  if (isNative || typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "dark";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

async function updateMacDockBadge(count?: number) {
  if (isNative || !getIsElectronRuntimeMac()) return;

  const desktopWindow = getDesktopHost()?.window?.getCurrentWindow?.();
  if (!desktopWindow || typeof desktopWindow.setBadgeCount !== "function") {
    return;
  }

  try {
    await desktopWindow.setBadgeCount(count);
  } catch (error) {
    console.warn("[useFaviconStatus] Failed to update macOS dock badge", error);
  }
}

export function useFaviconStatus() {
  const daemons = useHosts();
  const serverIds = useMemo(() => daemons.map((daemon) => daemon.serverId), [daemons]);
  // The favicon reads the whole fleet, so it has to keep every host's directory loading even
  // though it no longer subscribes to the agent maps.
  useAllDirectoryDemand({ serverIds, enabled: !isNative });
  const selectFaviconStatus = useMemo(createFaviconStatusSelector, []);
  const selectMacDockBadgeCount = useMemo(createMacDockBadgeCountSelector, []);
  const status = useSessionStore(selectFaviconStatus);
  const dockBadgeCount = useSessionStore(selectMacDockBadgeCount);
  const [colorScheme, setColorScheme] = useState<ColorScheme>(getSystemColorScheme);
  const lastDockBadgeCountRef = useRef<number | undefined>(undefined);

  // Listen for system color scheme changes
  useEffect(() => {
    if (isNative || typeof window === "undefined") return;

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => {
      setColorScheme(e.matches ? "dark" : "light");
    };

    mediaQuery.addEventListener("change", handler);
    return () => mediaQuery.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    if (isNative) return;
    updateFavicon(status, colorScheme);
  }, [status, colorScheme]);

  useEffect(() => {
    if (isNative) return;
    if (dockBadgeCount === lastDockBadgeCountRef.current) return;
    lastDockBadgeCountRef.current = dockBadgeCount;
    void updateMacDockBadge(dockBadgeCount);
  }, [dockBadgeCount]);
}
