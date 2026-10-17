import type { PluginWorkspaceRowTakeoverOptions } from "@getpaseo/plugin/client";
import { useSyncExternalStore } from "react";
import type { EvaluatedWorkspaceRowAccessory, InstalledPlugin } from "./types";

export interface ActiveRowTakeover {
  plugin: InstalledPlugin;
  Overlay: NonNullable<EvaluatedWorkspaceRowAccessory["Overlay"]>;
  data: unknown;
}

const takeovers = new Map<string, ActiveRowTakeover>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * Plays a plugin's accessory Overlay on one of its host's rows, one takeover per row. The host
 * owns the end: time up, `cancel()`, or the plugin's installation being disposed.
 */
export function startRowTakeover(
  plugin: InstalledPlugin,
  workspaceId: string,
  { durationMs, data }: PluginWorkspaceRowTakeoverOptions,
) {
  const Overlay = plugin.workspaceRowAccessories.findLast((entry) => entry.Overlay)?.Overlay;
  if (!Overlay) throw new Error("A row takeover needs a row accessory with an Overlay");
  if (!(durationMs > 0 && durationMs <= 10_000)) {
    throw new Error("Invalid row takeover: durationMs must be within (0, 10000]");
  }
  // Same key the sidebar builds for its rows.
  const key = `${plugin.serverId}:${workspaceId}`;
  const { signal } = plugin.lifetime;
  if (signal.aborted || takeovers.has(key)) return null;

  const takeover: ActiveRowTakeover = { plugin, Overlay, data };
  let settle: (outcome: "completed" | "cancelled") => void = () => undefined;
  const finished = new Promise<"completed" | "cancelled">((resolve) => (settle = resolve));
  const end = (outcome: "completed" | "cancelled") => {
    if (takeovers.get(key) !== takeover) return;
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    takeovers.delete(key);
    emit();
    settle(outcome);
  };
  const cancel = () => end("cancelled");
  const timer = setTimeout(() => end("completed"), durationMs);
  signal.addEventListener("abort", cancel);
  takeovers.set(key, takeover);
  emit();
  return { cancel, finished };
}

export function useRowTakeover(workspaceKey: string): ActiveRowTakeover | null {
  const get = () => takeovers.get(workspaceKey) ?? null;
  return useSyncExternalStore(subscribe, get, get);
}
