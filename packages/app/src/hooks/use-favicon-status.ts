import { useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import { getIsTauriMac } from "@/constants/layout";
import { useAggregatedAgents } from "./use-aggregated-agents";
import { getCurrentTauriWindow } from "@/utils/tauri";

type FaviconStatus = "none" | "running" | "attention";
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

function deriveFaviconStatus(
  agents: ReturnType<typeof useAggregatedAgents>["agents"]
): FaviconStatus {
  const hasRunning = agents.some((agent) => agent.status === "running");
  if (hasRunning) {
    return "running";
  }
  const hasAttention = agents.some((agent) => agent.requiresAttention);
  if (hasAttention) {
    return "attention";
  }
  return "none";
}

function deriveMacDockBadgeCount(
  agents: ReturnType<typeof useAggregatedAgents>["agents"]
): number | undefined {
  const attentionCount = agents.filter(
    (agent) =>
      agent.requiresAttention &&
      (agent.attentionReason === "permission" || agent.attentionReason === "finished")
  ).length;
  if (attentionCount > 0) {
    return attentionCount;
  }

  return undefined;
}

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
  if (Platform.OS !== "web" || typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "dark";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

async function updateMacDockBadge(count?: number) {
  if (Platform.OS !== "web" || !getIsTauriMac()) return;

  const tauriWindow = getCurrentTauriWindow();
  if (!tauriWindow || typeof tauriWindow.setBadgeCount !== "function") {
    return;
  }

  try {
    await tauriWindow.setBadgeCount(count);
  } catch (error) {
    console.warn("[useFaviconStatus] Failed to update macOS dock badge", error);
  }
}

export function useFaviconStatus() {
  const { agents } = useAggregatedAgents();
  const [colorScheme, setColorScheme] = useState<ColorScheme>(getSystemColorScheme);
  const lastDockBadgeCountRef = useRef<number | undefined>(undefined);

  // Listen for system color scheme changes
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => {
      setColorScheme(e.matches ? "dark" : "light");
    };

    mediaQuery.addEventListener("change", handler);
    return () => mediaQuery.removeEventListener("change", handler);
  }, []);

  // Update favicon when agents or color scheme changes
  useEffect(() => {
    if (Platform.OS !== "web") return;

    const status = deriveFaviconStatus(agents);
    updateFavicon(status, colorScheme);

    const dockBadgeCount = deriveMacDockBadgeCount(agents);
    if (dockBadgeCount !== lastDockBadgeCountRef.current) {
      lastDockBadgeCountRef.current = dockBadgeCount;
      void updateMacDockBadge(dockBadgeCount);
    }
  }, [agents, colorScheme]);
}
