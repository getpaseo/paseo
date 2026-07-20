/**
 * pane-find-controller.ts
 *
 * Pure, framework-free registry that owns "which pane does Ctrl/Cmd+F reach".
 * Panes register a `PaneFindAdapter` keyed by a stable pane key and report
 * their own focus state; the controller tracks the single focused pane and
 * routes open/close/query/next/prev commands to that pane's adapter.
 *
 * Kept independent of the keyboard dispatcher: `workspace.find.open` calls
 * `openActive()` once, globally, instead of every pane registering its own
 * keyboard handler.
 */

import type { PaneFindAdapter, PaneFindState } from "./pane-find-types";

export interface PaneFindController {
  register(paneKey: string, adapter: PaneFindAdapter): () => void;
  setFocusedPane(paneKey: string): void;
  clearFocusedPaneIfCurrent(paneKey: string): void;
  getFocusedPane(): string | null;
  getActiveAdapter(): PaneFindAdapter | null;
  getActiveState(): PaneFindState | null;
  getFocusRequestRevision(): number;
  openActive(): boolean;
  closeActive(): void;
  setQueryActive(query: string): void;
  selectNextActive(): void;
  selectPrevActive(): void;
  subscribe(listener: () => void): () => void;
}

export function createPaneFindController(): PaneFindController {
  const adaptersByPaneKey = new Map<string, PaneFindAdapter>();
  let focusedPaneKey: string | null = null;
  let focusRequestRevision = 0;
  const listeners = new Set<() => void>();

  function notify() {
    for (const listener of listeners) {
      listener();
    }
  }

  function getActiveAdapter(): PaneFindAdapter | null {
    if (!focusedPaneKey) return null;
    return adaptersByPaneKey.get(focusedPaneKey) ?? null;
  }

  return {
    register(paneKey, adapter) {
      adaptersByPaneKey.set(paneKey, adapter);
      notify();
      return () => {
        if (adaptersByPaneKey.get(paneKey) !== adapter) return;
        adaptersByPaneKey.delete(paneKey);
        // Focus ownership is managed centrally (WorkspacePaneContent), keyed by
        // the pane slot — NOT by adapter lifetime. Deliberately don't clear
        // focusedPaneKey here: a pane may swap its adapter (e.g. retargeted to a
        // new agent) while staying focused, and clearing here would drop
        // Ctrl/Cmd+F ownership until the next focus change. getActiveAdapter()
        // already returns null when no adapter is registered for the focused
        // key, so a truly-gone pane degrades gracefully.
        notify();
      };
    },

    setFocusedPane(paneKey) {
      if (focusedPaneKey === paneKey) return;
      focusedPaneKey = paneKey;
      notify();
    },

    clearFocusedPaneIfCurrent(paneKey) {
      if (focusedPaneKey !== paneKey) return;
      focusedPaneKey = null;
      notify();
    },

    getFocusedPane() {
      return focusedPaneKey;
    },

    getActiveAdapter,

    getActiveState() {
      return getActiveAdapter()?.getState() ?? null;
    },

    getFocusRequestRevision() {
      return focusRequestRevision;
    },

    openActive() {
      const adapter = getActiveAdapter();
      if (!adapter) return false;
      adapter.open();
      // `open()` can be called again while its find bar remains mounted. The
      // revision gives that bar a fresh, subscribable focus request instead of
      // relying only on TextInput's mount-time autoFocus.
      focusRequestRevision += 1;
      notify();
      return true;
    },

    closeActive() {
      getActiveAdapter()?.close();
    },

    setQueryActive(query) {
      getActiveAdapter()?.setQuery(query);
    },

    selectNextActive() {
      getActiveAdapter()?.selectNext();
    },

    selectPrevActive() {
      getActiveAdapter()?.selectPrev();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const paneFindController = createPaneFindController();
