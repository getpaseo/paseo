import type { PluginWorkspaceGrouping, PluginWorkspaceList } from "@getpaseo/plugin/client";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";

export interface PluginWorkspaceListSource {
  getGrouping(): PluginWorkspaceGrouping;
  setGrouping(grouping: PluginWorkspaceGrouping): void;
  subscribeGrouping(listener: (grouping: PluginWorkspaceGrouping) => void): () => void;
}

export const pluginWorkspaceListSource: PluginWorkspaceListSource = {
  getGrouping: () => useSidebarViewStore.getState().groupMode,
  setGrouping: (grouping) => useSidebarViewStore.getState().setGroupMode(grouping),
  subscribeGrouping(listener) {
    let previous = useSidebarViewStore.getState().groupMode;
    return useSidebarViewStore.subscribe((state) => {
      if (state.groupMode === previous) return;
      previous = state.groupMode;
      listener(previous);
    });
  },
};

export function createPluginWorkspaceList(
  source: PluginWorkspaceListSource,
  signal: AbortSignal,
): PluginWorkspaceList {
  const subscriptions = new Set<() => void>();
  function stop() {
    for (const unsubscribe of subscriptions) unsubscribe();
    subscriptions.clear();
  }
  if (signal.aborted) stop();
  else signal.addEventListener("abort", stop, { once: true });

  return {
    getGrouping() {
      if (signal.aborted) throw new Error("Plugin has stopped");
      return source.getGrouping();
    },
    setGrouping(grouping) {
      if (signal.aborted) throw new Error("Plugin has stopped");
      if (grouping !== "project" && grouping !== "status") {
        throw new Error(`Invalid workspace grouping: ${String(grouping)}`);
      }
      source.setGrouping(grouping);
    },
    subscribeGrouping(listener) {
      if (signal.aborted) return () => {};
      if (typeof listener !== "function") {
        throw new Error("Workspace grouping subscription needs a listener");
      }
      const unsubscribeSource = source.subscribeGrouping(listener);
      let active = true;
      const unsubscribe = () => {
        if (!active) return;
        active = false;
        subscriptions.delete(unsubscribe);
        unsubscribeSource();
      };
      subscriptions.add(unsubscribe);
      return unsubscribe;
    },
  };
}
