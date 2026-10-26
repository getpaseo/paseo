import { useLayoutEffect } from "react";
import { usePathname, useRootNavigationState } from "expo-router";
import { useStore } from "zustand";
import {
  useIsLastWorkspaceSelectionHydrated,
  useLastWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { createSettingsSelection } from "./model";

const selection = createSettingsSelection();

// Mount once above the sibling Settings routes so replacements and Back share
// one visit, and leaving Settings gives the next workspace entry a fresh default.
export function useSettingsRouteEntry(): void {
  const pathname = usePathname();
  const navigationState = useRootNavigationState();
  const routeKey = navigationState?.routes[navigationState.index]?.key;
  const workspace = useLastWorkspaceSelection();
  const isWorkspaceHydrated = useIsLastWorkspaceSelectionHydrated();
  const workspaceServerId = workspace?.serverId ?? null;
  useLayoutEffect(() => {
    if (isWorkspaceHydrated && routeKey) {
      selection.enterRoute({ key: routeKey, pathname }, workspaceServerId);
    }
  }, [pathname, routeKey, workspaceServerId, isWorkspaceHydrated]);
}

export function useSettingsHostSelection(): string | null {
  return useStore(selection.store, (state) => state.selectedServerId);
}

export const selectSettingsHost = selection.selectHost;
