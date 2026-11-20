import { useIsCompactFormFactor } from "@/constants/layout";
import { usePanelStore, type LeftSidebarPresentation } from "@/stores/panel-store";
import { useCallback, useLayoutEffect, useRef } from "react";
import { ScrollView, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { usePathname, useRootNavigationState } from "expo-router";
import { useIsFocused, type ParamListBase } from "expo-router/react-navigation";
import { useNavigation } from "expo-router";
import type { NativeStackNavigationProp } from "expo-router/native-stack";
import { isWeb } from "@/constants/platform";
import { useStore } from "zustand";
import {
  useIsLastWorkspaceSelectionHydrated,
  useLastWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { settingsPresentation as selection } from "./session";

// Mount once above the sibling Settings routes so replacements and Back share
// one visit, and leaving Settings gives the next workspace entry a fresh default.
export function useSettingsRouteEntry(): void {
  const pathname = usePathname();
  const isCompact = useIsCompactFormFactor();
  const navigationState = useRootNavigationState();
  const routeKey = navigationState?.routes[navigationState.index]?.key;
  const workspace = useLastWorkspaceSelection();
  const isWorkspaceHydrated = useIsLastWorkspaceSelectionHydrated();
  const workspaceServerId = workspace?.serverId ?? null;
  useLayoutEffect(() => {
    if (isWorkspaceHydrated && routeKey) {
      if (!isCompact) selection.clearSidebarReturn();
      if (selection.enterRoute({ key: routeKey, pathname }, workspaceServerId)) {
        usePanelStore.getState().showMobileAgent();
      }
    }
  }, [pathname, routeKey, workspaceServerId, isWorkspaceHydrated, isCompact]);
}

export function useSettingsHostSelection(): string | null {
  return useStore(selection.store, (state) => state.selectedServerId);
}

export function useSettingsSidebarPresentation(input: {
  presentation: LeftSidebarPresentation;
  visible: boolean;
}): { presentation: LeftSidebarPresentation; visible: boolean } {
  const origin = useStore(selection.store, (state) => state.sidebarReturn);
  const pathname = usePathname();
  const compact = useIsCompactFormFactor();
  if (compact && origin && (pathname === "/settings" || pathname.startsWith("/settings/"))) {
    return { presentation: "suspended", visible: origin.phase === "opening" };
  }
  return input;
}

// Native layout precedes screen appearance; only the navigator can finish that handoff.
export function useSettingsContentPresented() {
  const focused = useIsFocused();
  const navigation = useNavigation<NativeStackNavigationProp<ParamListBase>>();
  useLayoutEffect(() => {
    if (isWeb) return;
    return navigation.addListener("transitionEnd", ({ data }) => {
      if (!data.closing) selection.presentContent();
    });
  }, [navigation]);
  return useCallback(() => {
    if (isWeb && focused) selection.presentContent();
  }, [focused]);
}

export const selectSettingsHost = selection.selectHost;

// Sibling routes remount the wide sidebar. Only the current mount owns its
// offset: RN Web can deliver its final scroll callback after unmount.
export function useSettingsSidebarScroll(enabled: boolean) {
  const ref = useRef<ScrollView>(null);
  const owner = useRef<ReturnType<typeof selection.attachSidebar> | null>(null);
  const restore = useCallback(() => {
    if (owner.current) ref.current?.scrollTo({ y: owner.current.offset, animated: false });
  }, []);
  useLayoutEffect(() => {
    if (!enabled) return;
    const sidebar = selection.attachSidebar();
    owner.current = sidebar;
    restore();
    return () => {
      sidebar.detach();
      owner.current = null;
    };
  }, [enabled, restore]);
  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    owner.current?.remember(event.nativeEvent.contentOffset.y);
  }, []);
  return { ref, onScroll, onContentSizeChange: restore, scrollEventThrottle: 16 };
}
