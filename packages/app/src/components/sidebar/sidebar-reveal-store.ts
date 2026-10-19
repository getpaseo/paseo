import { useEffect, useRef, type MutableRefObject, type RefObject } from "react";
import { create } from "zustand";
import type { View } from "react-native";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { usePanelStore } from "@/stores/panel-store";
import { isCompactFormFactorSnapshot } from "@/constants/layout";

/**
 * "Reveal in sidebar": the flow that opens the sidebar, scrolls the workspace list to a row, and
 * flashes it. The request travels through this store because the caller (command center, header
 * menu) knows only the workspace identity, while the row and the scroll container live deep in the
 * sidebar list components.
 */

export interface SidebarRevealRequest {
  workspaceKey: string;
  /** Monotonic, so repeating a reveal for the same row retriggers scroll and flash. */
  token: number;
  createdAt: number;
}

export interface SidebarRevealFlash {
  workspaceKey: string;
  token: number;
}

interface SidebarRevealState {
  request: SidebarRevealRequest | null;
  flash: SidebarRevealFlash | null;
  requestReveal: (input: { serverId: string; workspaceId: string }) => void;
  beginFlash: (input: { workspaceKey: string; token: number }) => void;
  completeFlash: (token: number) => void;
  consumeRequest: (token: number) => void;
}

let nextRevealToken = 0;

export const useSidebarRevealStore = create<SidebarRevealState>()((set) => ({
  request: null,
  flash: null,
  requestReveal: ({ serverId, workspaceId }) => {
    const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
    if (!workspaceKey) return;
    nextRevealToken += 1;
    set({
      request: { workspaceKey, token: nextRevealToken, createdAt: Date.now() },
      flash: null,
    });
  },
  beginFlash: ({ workspaceKey, token }) => set({ flash: { workspaceKey, token } }),
  completeFlash: (token) =>
    set((state) => (state.flash?.token === token ? { flash: null } : state)),
  consumeRequest: (token) =>
    set((state) => (state.request?.token === token ? { request: null } : state)),
}));

/** Open the sidebar, then ask it to scroll to and flash the workspace's row. */
export function requestSidebarWorkspaceReveal(input: {
  serverId: string;
  workspaceId: string;
}): void {
  const panel = usePanelStore.getState();
  if (panel.desktop.focusModeEnabled) {
    panel.exitFocusMode();
  }
  panel.openAgentListForLayout({ isCompact: isCompactFormFactorSnapshot() });
  useSidebarRevealStore.getState().requestReveal(input);
}

/**
 * Mounted workspace rows publish their container here so the scroll owner can measure them
 * without threading refs through every list layer. Keyed by `workspaceKey`; at most one sidebar
 * list is mounted per form factor, so one row per key.
 */
const revealRowRefs = new Map<string, RefObject<View | null>>();

export function registerRevealRow(input: {
  workspaceKey: string;
  ref: RefObject<View | null>;
}): () => void {
  revealRowRefs.set(input.workspaceKey, input.ref);
  return () => {
    if (revealRowRefs.get(input.workspaceKey) === input.ref) {
      revealRowRefs.delete(input.workspaceKey);
    }
  };
}

export function getRevealRowRef(workspaceKey: string): RefObject<View | null> | null {
  return revealRowRefs.get(workspaceKey) ?? null;
}

/**
 * The row's own container ref, registered for the reveal flow. Rows that also carry a drag
 * handle compose their activator ref with this one at the call site.
 */
export function useRevealRowRef(workspaceKey: string): MutableRefObject<View | null> {
  const ref = useRef<View | null>(null);
  useEffect(() => registerRevealRow({ workspaceKey, ref }), [workspaceKey]);
  return ref;
}
