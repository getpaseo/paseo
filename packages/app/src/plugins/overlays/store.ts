import { Platform } from "react-native";
import type { ComponentType } from "react";
import type { PluginOverlayHandle, PluginOverlayProps } from "@getpaseo/plugin/client";
import { IOS_TEARDOWN_GRACE_MS } from "@/components/ui/menu/menu-context";

export interface PluginOverlayEntry {
  key: number;
  serverId: string;
  pluginId: string;
  Component: ComponentType<PluginOverlayProps>;
  close(): void;
}

export interface PluginOverlayRequest {
  serverId: string;
  pluginId: string;
  Component: ComponentType<PluginOverlayProps>;
}

/** Runs `mount` once the opener has had a chance to leave; returns a cancel. */
export type PluginOverlaySchedule = (mount: () => void) => () => void;

function isComponent(value: unknown): boolean {
  return (
    typeof value === "function" ||
    (typeof value === "object" && value !== null && "$$typeof" in value)
  );
}

/**
 * Overlays opened with `openOverlay`. They live here rather than under their opener because the
 * opener is often on its way out — a popover that closed itself, a Command Center row, a slash
 * command whose composer just cleared.
 */
export function createPluginOverlayStore(schedule: PluginOverlaySchedule) {
  let entries: readonly PluginOverlayEntry[] = [];
  let nextKey = 0;
  const listeners = new Set<() => void>();

  function publish(next: readonly PluginOverlayEntry[]): void {
    entries = next;
    for (const listener of listeners) listener();
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot(): readonly PluginOverlayEntry[] {
      return entries;
    },
    open(request: PluginOverlayRequest): PluginOverlayHandle {
      if (!isComponent(request.Component)) throw new Error("Plugin overlay needs a component");
      const key = ++nextKey;
      let closed = false;
      function close(): void {
        if (closed) return;
        closed = true;
        cancel();
        if (entries.some((entry) => entry.key === key))
          publish(entries.filter((entry) => entry.key !== key));
      }
      const cancel = schedule(() => {
        if (closed) return;
        publish([...entries, { key, ...request, close }]);
      });
      return { close };
    },
  };
}

/**
 * The opener's surface is still unmounting when `openOverlay` runs. On the web its teardown
 * restores focus, so wait a frame; on iOS a modal presented while UIKit dismisses another can
 * hang, so wait out the same grace the menu engine gives its actions.
 */
function scheduleAfterOpenerLeaves(mount: () => void): () => void {
  if (Platform.OS === "ios") {
    const timer = setTimeout(mount, IOS_TEARDOWN_GRACE_MS);
    return () => clearTimeout(timer);
  }
  const frame = requestAnimationFrame(mount);
  return () => cancelAnimationFrame(frame);
}

export const pluginOverlayStore = createPluginOverlayStore(scheduleAfterOpenerLeaves);
