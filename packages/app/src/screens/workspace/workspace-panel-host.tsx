import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import type { ViewStyle } from "react-native";
import invariant from "tiny-invariant";
import { RetainedPanel } from "@/components/retained-panel";
import { useModifiedPanelTabIds } from "@/panels/panel-instance-attributes";
import {
  WorkspacePaneContent,
  type WorkspacePaneContentModel,
} from "@/screens/workspace/workspace-pane-content";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import { useMountedTabSet } from "@/screens/workspace/use-mounted-tab-set";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { workspaceTabTargetsEqual } from "@/workspace-tabs/identity";
import { RenderProfile } from "@/utils/render-profiler";

interface WorkspacePanelHostProps {
  paneId: string;
  tabs: WorkspaceTabDescriptor[];
  activeTabId: string | null;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  isWorkspaceFocused: boolean;
  isPaneFocused: boolean;
  onFocusPane?: (paneId: string) => void;
  buildPaneContentModel: (input: {
    paneId: string;
    tab: WorkspaceTabDescriptor;
  }) => WorkspacePaneContentModel;
  /** Shows a second tab below the active one. Only the Explorer dock passes it. */
  split?: WorkspacePanelHostSplit;
}

export type WorkspacePanelHostSlot = "top" | "bottom";

export interface WorkspacePanelHostSplit {
  lowerTabId: string;
  activeSlot: WorkspacePanelHostSlot;
  /** Share of `containerHeight` given to the top slot. The caller clamps it. */
  ratio: number;
  containerHeight: number;
  lowerHeaderHeight: number;
  onFocusSlot: (slot: WorkspacePanelHostSlot) => void;
}

interface MountedTabProps {
  tab: WorkspaceTabDescriptor;
  paneId: string;
  visible: boolean;
  interactive: boolean;
  isWorkspaceFocused: boolean;
  onFocusPane?: (paneId: string) => void;
  buildPaneContentModel: WorkspacePanelHostProps["buildPaneContentModel"];
  slotStyle?: ViewStyle;
  slot?: WorkspacePanelHostSlot;
  onFocusSlot?: (slot: WorkspacePanelHostSlot) => void;
}

const SLOT_DATA_SETS = {
  top: { explorerSlot: "top" },
  bottom: { explorerSlot: "bottom" },
} as const;

const MountedTab = memo(function MountedTab({
  tab,
  paneId,
  visible,
  interactive,
  isWorkspaceFocused,
  onFocusPane,
  buildPaneContentModel,
  slotStyle,
  slot,
  onFocusSlot,
}: MountedTabProps) {
  const content = useMemo(
    () => buildPaneContentModel({ paneId, tab }),
    [buildPaneContentModel, paneId, tab],
  );
  const slotFocusHandler = slot ? onFocusSlot : undefined;
  const handleFocusPane = useCallback(() => {
    onFocusPane?.(paneId);
    if (slot) slotFocusHandler?.(slot);
  }, [onFocusPane, paneId, slot, slotFocusHandler]);
  const hasFocusHandler = Boolean(onFocusPane || slotFocusHandler);
  return (
    <RenderProfile id={`DesktopMountedTab:${tab.kind}:${tab.tabId}`}>
      <RetainedPanel
        active={visible}
        style={slotStyle}
        dataSet={slot ? SLOT_DATA_SETS[slot] : undefined}
      >
        <WorkspacePaneContent
          content={content}
          isWorkspaceFocused={isWorkspaceFocused}
          isPaneFocused={interactive}
          onFocusPane={hasFocusHandler ? handleFocusPane : undefined}
        />
      </RetainedPanel>
    </RenderProfile>
  );
});

function useStableTabs(tabs: WorkspaceTabDescriptor[]) {
  const cacheRef = useRef(new Map<string, WorkspaceTabDescriptor>());
  const stableTabs = useMemo(() => {
    const next = new Map<string, WorkspaceTabDescriptor>();
    for (const tab of tabs) {
      const cached = cacheRef.current.get(tab.tabId);
      next.set(
        tab.tabId,
        cached &&
          cached.key === tab.key &&
          cached.kind === tab.kind &&
          cached.state === tab.state &&
          workspaceTabTargetsEqual(cached.target, tab.target)
          ? cached
          : tab,
      );
    }
    return next;
  }, [tabs]);
  useEffect(() => {
    cacheRef.current = stableTabs;
  }, [stableTabs]);
  return stableTabs;
}

/** Mounts panel implementations behind the shared host contract and retains modified tabs. */
export function WorkspacePanelHost({
  paneId,
  tabs,
  activeTabId,
  normalizedServerId,
  normalizedWorkspaceId,
  isWorkspaceFocused,
  isPaneFocused,
  onFocusPane,
  buildPaneContentModel,
  split,
}: WorkspacePanelHostProps) {
  const tabIds = useMemo(() => tabs.map((tab) => tab.tabId), [tabs]);
  const modifiedTabIds = useModifiedPanelTabIds({
    serverId: normalizedServerId,
    workspaceId: normalizedWorkspaceId,
    tabIds,
  });
  const lowerTabId = split?.lowerTabId ?? null;
  if (lowerTabId) {
    invariant(
      lowerTabId !== activeTabId,
      `Explorer split bottom tab ${lowerTabId} is the active tab`,
    );
    invariant(
      tabIds.includes(lowerTabId),
      `Explorer split bottom tab ${lowerTabId} is not among the host's tabs`,
    );
  }
  const retainedTabIds = useMemo(
    () => (lowerTabId ? new Set([...modifiedTabIds, lowerTabId]) : modifiedTabIds),
    [lowerTabId, modifiedTabIds],
  );
  const stableTabs = useStableTabs(tabs);
  const { mountedTabIds } = useMountedTabSet({
    activeTabId,
    allTabIds: tabIds,
    retainedTabIds,
    cap: 3,
  });
  const mountedIds = useMemo(
    () => tabIds.filter((tabId) => mountedTabIds.has(tabId)),
    [mountedTabIds, tabIds],
  );

  const slotStyles = useSplitSlotStyles(split);

  return mountedIds.map((tabId) => {
    const tab = stableTabs.get(tabId);
    if (!tab) return null;
    const visible = tabId === activeTabId || tabId === lowerTabId;
    let slot: WorkspacePanelHostSlot | undefined;
    if (split && tabId === activeTabId) slot = "top";
    if (split && tabId === lowerTabId) slot = "bottom";
    const slotStyle = slot && slotStyles ? slotStyles[slot] : undefined;
    const inActiveSlot = split
      ? tabId === (split.activeSlot === "bottom" ? lowerTabId : activeTabId)
      : visible;
    return (
      <MountedTab
        key={tabId}
        tab={tab}
        paneId={paneId}
        visible={visible}
        interactive={isPaneFocused && inActiveSlot}
        isWorkspaceFocused={isWorkspaceFocused}
        onFocusPane={onFocusPane}
        buildPaneContentModel={buildPaneContentModel}
        slotStyle={slotStyle}
        slot={slot}
        onFocusSlot={split?.onFocusSlot}
      />
    );
  });
}

/**
 * Places the two visible tabs by absolute position only. Moving a tab between slots changes its
 * style, never its parent or sibling position, so its panel keeps its state.
 */
function useSplitSlotStyles(
  split: WorkspacePanelHostSplit | undefined,
): { top: ViewStyle; bottom: ViewStyle } | null {
  const ratio = split?.ratio;
  const containerHeight = split?.containerHeight;
  const lowerHeaderHeight = split?.lowerHeaderHeight;
  return useMemo(() => {
    if (ratio === undefined || containerHeight === undefined || lowerHeaderHeight === undefined) {
      return null;
    }
    const topHeight = ratio * containerHeight;
    // Geometry changes on every divider drag step, so it stays out of the shared stylesheet.
    return {
      top: inlineUnistylesStyle<ViewStyle>({
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: topHeight,
      }),
      bottom: inlineUnistylesStyle<ViewStyle>({
        position: "absolute",
        top: topHeight + lowerHeaderHeight,
        left: 0,
        right: 0,
        height: containerHeight - topHeight - lowerHeaderHeight,
      }),
    };
  }, [containerHeight, lowerHeaderHeight, ratio]);
}
