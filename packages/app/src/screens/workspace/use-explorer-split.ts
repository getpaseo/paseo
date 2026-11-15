import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { LayoutChangeEvent, View } from "react-native";
import { shouldFocusPaneFromEventTarget } from "@/components/split-container-pane-focus";
import { isNative } from "@/constants/platform";
import type {
  WorkspacePanelHostSlot,
  WorkspacePanelHostSplit,
} from "@/screens/workspace/workspace-panel-host";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import {
  canShowExplorerTabBelow,
  clampExplorerSplitRatioToHeight,
  deriveExplorerSplitView,
  explorerSplitFitsHeight,
  nextEligibleExplorerTabId,
  selectExplorerActiveHalf,
  toggleExplorerSplit,
  useExplorerSplitStore,
  useExplorerSplitStoreHydrated,
} from "@/stores/explorer-split-store";
import {
  useWorkspaceLayoutStoreHydrated,
  type WorkspaceLayoutMode,
} from "@/stores/workspace-layout-store";

/** Height of the bottom half's header, which carries its title and the unsplit button. */
export const EXPLORER_SPLIT_HEADER_HEIGHT = 28;

export interface ExplorerSplitDivider {
  top: number;
  sizes: number[];
  containerSize: number;
  onPreview: (groupId: string, sizes: number[]) => void;
  onCommit: (groupId: string, sizes: number[]) => void;
}

export interface ExplorerSplitController {
  contentRef: RefObject<View | null>;
  onContentLayout: (event: LayoutChangeEvent) => void;
  /** The tab the host shows on top: the active tab. */
  hostActiveTabId: string | null;
  hostSplit: WorkspacePanelHostSplit | undefined;
  lowerTab: WorkspaceTabDescriptor | null;
  divider: ExplorerSplitDivider | null;
  canSplit: boolean;
  isSplit: boolean;
  /** Makes the top half active; the dock calls it when the user selects a tab in the row. */
  activateTopHalf: () => void;
  toggle: () => void;
  unsplit: () => void;
  canShowBelow: (tab: WorkspaceTabDescriptor) => boolean;
  showBelow: (tab: WorkspaceTabDescriptor) => void;
}

/**
 * Wires the Explorer dock to the split store: what each half shows, the swap and cleanup commits,
 * the divider, and the active half. The rules themselves live in `deriveExplorerSplitView`.
 */
export function useExplorerSplit(input: {
  workspaceKey: string;
  layoutMode: WorkspaceLayoutMode;
  tabs: WorkspaceTabDescriptor[];
  activeTabId: string | null;
}): ExplorerSplitController {
  const { workspaceKey, layoutMode, tabs, activeTabId } = input;
  const entry = useExplorerSplitStore((state) => state.entries[workspaceKey]);
  const activeHalf = useExplorerSplitStore((state) =>
    selectExplorerActiveHalf(state, workspaceKey),
  );
  const splitHydrated = useExplorerSplitStoreHydrated();
  const layoutHydrated = useWorkspaceLayoutStoreHydrated();
  const lastTopTabIdRef = useRef<string | null>(null);

  const view = deriveExplorerSplitView({
    explorerTabs: tabs,
    activeTabId,
    lowerTabId: entry?.lowerTabId ?? null,
    lastTopTabId: lastTopTabIdRef.current,
    layoutMode,
  });
  const splitTopTabId = view.kind === "split" ? view.topTabId : null;
  const splitLowerTabId = view.kind === "split" ? view.lowerTabId : null;
  const singleReason = view.kind === "single" ? view.reason : null;

  useEffect(() => {
    if (splitTopTabId) lastTopTabIdRef.current = splitTopTabId;
  }, [splitTopTabId]);

  useEffect(() => {
    const store = useExplorerSplitStore.getState();
    if (splitLowerTabId && entry && splitLowerTabId !== entry.lowerTabId) {
      store.swap(workspaceKey, splitLowerTabId);
      return;
    }
    // Before both stores load, a saved bottom tab can look missing; never clear it then.
    if (!splitHydrated || !layoutHydrated) return;
    if (singleReason === "missing" || singleReason === "ended") store.unsplit(workspaceKey);
  }, [entry, layoutHydrated, singleReason, splitHydrated, splitLowerTabId, workspaceKey]);

  const contentRef = useRef<View | null>(null);
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const onContentLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    // A hidden dock (`display: none`) measures zero; keep the last real height until it is shown.
    if (width <= 0 || height <= 0) return;
    setContentHeight(height);
  }, []);
  const setActiveHalf = useCallback(
    (slot: WorkspacePanelHostSlot) =>
      useExplorerSplitStore.getState().setActiveHalf(workspaceKey, slot),
    [workspaceKey],
  );
  useExplorerActiveHalfListener(contentRef, setActiveHalf);
  const activateTopHalf = useCallback(() => setActiveHalf("top"), [setActiveHalf]);

  // Drag previews stay in this component; the store is written once, on release.
  const [previewRatio, setPreviewRatio] = useState<number | null>(null);
  const fits =
    contentHeight !== null && explorerSplitFitsHeight(contentHeight, EXPLORER_SPLIT_HEADER_HEIGHT);
  const ratio =
    entry && contentHeight !== null && fits
      ? clampExplorerSplitRatioToHeight(
          previewRatio ?? entry.ratio,
          contentHeight,
          EXPLORER_SPLIT_HEADER_HEIGHT,
        )
      : null;
  const shown = splitLowerTabId !== null && ratio !== null && contentHeight !== null;

  const hostSplit = useMemo<WorkspacePanelHostSplit | undefined>(
    () =>
      shown && splitLowerTabId && ratio !== null && contentHeight !== null
        ? {
            lowerTabId: splitLowerTabId,
            activeSlot: activeHalf,
            ratio,
            containerHeight: contentHeight,
            lowerHeaderHeight: EXPLORER_SPLIT_HEADER_HEIGHT,
            onFocusSlot: setActiveHalf,
          }
        : undefined,
    [activeHalf, contentHeight, ratio, setActiveHalf, shown, splitLowerTabId],
  );

  const onPreview = useCallback((_groupId: string, sizes: number[]) => {
    setPreviewRatio(sizes[0] ?? null);
  }, []);
  const onCommit = useCallback(
    (_groupId: string, sizes: number[]) => {
      setPreviewRatio(null);
      const next = sizes[0];
      if (next === undefined || contentHeight === null) return;
      useExplorerSplitStore
        .getState()
        .setRatio(
          workspaceKey,
          clampExplorerSplitRatioToHeight(next, contentHeight, EXPLORER_SPLIT_HEADER_HEIGHT),
        );
    },
    [contentHeight, workspaceKey],
  );
  const divider = useMemo<ExplorerSplitDivider | null>(
    () =>
      shown && ratio !== null && contentHeight !== null
        ? {
            top: ratio * contentHeight,
            sizes: [ratio, 1 - ratio],
            containerSize: contentHeight,
            onPreview,
            onCommit,
          }
        : null,
    [contentHeight, onCommit, onPreview, ratio, shown],
  );

  const isDesktopLayout = layoutMode === "split-panes";
  const canSplit = isDesktopLayout && nextEligibleExplorerTabId(tabs, activeTabId) !== null;
  const toggle = useCallback(() => {
    if (!isDesktopLayout) return;
    toggleExplorerSplit({ workspaceKey, explorerTabs: tabs, activeTabId });
  }, [activeTabId, isDesktopLayout, tabs, workspaceKey]);
  const unsplit = useCallback(
    () => useExplorerSplitStore.getState().unsplit(workspaceKey),
    [workspaceKey],
  );
  const canShowBelow = useCallback(
    (tab: WorkspaceTabDescriptor) =>
      isDesktopLayout && canShowExplorerTabBelow(tab, activeTabId, splitLowerTabId),
    [activeTabId, isDesktopLayout, splitLowerTabId],
  );
  const showBelow = useCallback(
    (tab: WorkspaceTabDescriptor) => useExplorerSplitStore.getState().showBelow(workspaceKey, tab),
    [workspaceKey],
  );

  return {
    contentRef,
    onContentLayout,
    hostActiveTabId: activeTabId,
    hostSplit,
    lowerTab: shown ? (tabs.find((tab) => tab.tabId === splitLowerTabId) ?? null) : null,
    divider,
    canSplit,
    isSplit: entry !== undefined,
    activateTopHalf,
    toggle,
    unsplit,
    canShowBelow,
    showBelow,
  };
}

/**
 * Makes the half the user clicks or focuses into the active half, as main panes do for panes
 * (`split-container.tsx`). Panels that report focus themselves, such as the new-tab launcher,
 * reach the same state through the host's `onFocusSlot`.
 */
function useExplorerActiveHalfListener(
  contentRef: RefObject<View | null>,
  setActiveHalf: (slot: WorkspacePanelHostSlot) => void,
) {
  useEffect(() => {
    if (isNative) return;
    const rawRef: unknown = contentRef.current;
    if (!(rawRef instanceof HTMLElement)) return;
    const contentElement = rawRef;
    const handleEvent = (event: Event) => {
      if (!shouldFocusPaneFromEventTarget(event.target)) return;
      const target = event.target as Element | null;
      const slot = target?.closest?.("[data-explorer-slot]")?.getAttribute("data-explorer-slot");
      if (slot === "top" || slot === "bottom") setActiveHalf(slot);
    };
    contentElement.addEventListener("pointerdown", handleEvent, true);
    contentElement.addEventListener("focusin", handleEvent, true);
    return () => {
      contentElement.removeEventListener("pointerdown", handleEvent, true);
      contentElement.removeEventListener("focusin", handleEvent, true);
    };
  }, [contentRef, setActiveHalf]);
}
