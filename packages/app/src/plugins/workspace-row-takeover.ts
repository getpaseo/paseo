import type { PluginWorkspaceRowTakeoverOptions } from "@getpaseo/plugin/client";
import { useSyncExternalStore } from "react";
import type { EvaluatedWorkspaceRowAccessory, InstalledPlugin } from "./types";

export interface ActiveRowTakeover {
  plugin: InstalledPlugin;
  /** The accessory whose Overlay plays; removing it ends the takeover. */
  accessory: EvaluatedWorkspaceRowAccessory;
  Overlay: NonNullable<EvaluatedWorkspaceRowAccessory["Overlay"]>;
  data: unknown;
  /** Ends the takeover early, for example when its Overlay fails to render. */
  cancel(): void;
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
  accessories: readonly EvaluatedWorkspaceRowAccessory[],
  workspaceId: string,
  { durationMs, data }: PluginWorkspaceRowTakeoverOptions,
) {
  const accessory = accessories.findLast((entry) => entry.Overlay);
  const Overlay = accessory?.Overlay;
  if (!accessory || !Overlay)
    throw new Error("A row takeover needs a row accessory with an Overlay");
  if (!(durationMs > 0 && durationMs <= 10_000)) {
    throw new Error("Invalid row takeover: durationMs must be within (0, 10000]");
  }
  // Same key the sidebar builds for its rows.
  const key = `${plugin.serverId}:${workspaceId}`;
  const { signal } = plugin.lifetime;
  if (signal.aborted || takeovers.has(key)) return null;

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
  const takeover: ActiveRowTakeover = { plugin, accessory, Overlay, data, cancel };
  const timer = setTimeout(() => end("completed"), durationMs);
  signal.addEventListener("abort", cancel);
  takeovers.set(key, takeover);
  emit();
  return { cancel, finished };
}

/** Ends the takeovers playing `accessory`'s Overlay, once the plugin removes that accessory. */
export function endRowTakeoversOf(accessory: EvaluatedWorkspaceRowAccessory) {
  for (const takeover of takeovers.values()) {
    if (takeover.accessory === accessory) takeover.cancel();
  }
}

export function getRowTakeover(workspaceKey: string): ActiveRowTakeover | null {
  return takeovers.get(workspaceKey) ?? null;
}

export function useRowTakeover(workspaceKey: string): ActiveRowTakeover | null {
  const get = () => getRowTakeover(workspaceKey);
  return useSyncExternalStore(subscribe, get, get);
}
