import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  type ComponentType,
} from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Maximize2 } from "lucide-react-native";
import {
  SheetBottomInset,
  SheetDragArea,
  SheetHeaderIconButton,
  SheetHeaderView,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import type { PanelIconProps } from "@/panels/panel-registry";
import { getPanelRegistration } from "@/panels/panel-registry";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import { WorkspacePaneContent } from "@/screens/workspace/workspace-pane-content";
import { useWorkspaceLayoutStore, type SheetTab } from "@/stores/workspace-layout-store";
import { workspaceTabTargetsEqual } from "@/workspace-tabs/identity";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { useSheetPaneHost } from "./host";

function PanelIcon({
  icon: Icon,
  size,
  color,
}: { icon: ComponentType<PanelIconProps> } & PanelIconProps) {
  return <Icon size={size} color={color} />;
}

const ThemedPanelIcon = withUnistyles(PanelIcon, (theme) => ({
  color: theme.colors.foregroundMuted,
}));

export interface SheetPaneProps {
  sheet: SheetTab;
  /** Closes the sheet, everything it was chosen from included. */
  onClose: () => void;
  /** Steps back to the list the sheet was chosen from, when there is one. */
  onBack?: () => void;
  /** The pane closing the sheet uncovers, when the container knows it. */
  opener?: WorkspaceTabTarget | null;
  /** Only the top sheet's pane is focused; a covered one stays as live as the pane under it. */
  isTop: boolean;
}

interface SheetPaneExit {
  close: () => void;
  opener: WorkspaceTabTarget | null;
}

const SheetPaneExitContext = createContext<SheetPaneExit | null>(null);

/**
 * A tab shown in a sheet: its header (icon, title, Back, Open as tab, Close), which drags the
 * sheet, over its pane. Every sheet container renders this; only the container differs.
 */
export function SheetPane({ sheet, onClose, onBack, opener = null, isTop }: SheetPaneProps) {
  const { t } = useTranslation();
  const host = useSheetPaneHost();
  const { tab } = sheet;
  const registration = getPanelRegistration(tab.target.kind);
  if (!registration) {
    throw new Error(`No panel registration for kind: ${tab.target.kind}`);
  }
  const descriptor = registration.useDescriptor(tab.target as never, {
    serverId: host.serverId,
    workspaceId: host.workspaceId,
    tabId: tab.tabId,
  });

  const openTabInFront = useWorkspaceLayoutStore((state) => state.openTabInFront);
  const { workspaceKey } = host;
  const handleOpenAsTab = useCallback(
    () => openTabInFront(workspaceKey, sheet),
    [openTabInFront, sheet, workspaceKey],
  );
  const header = useMemo<SheetHeader>(
    () => ({
      title: descriptor.label,
      leading: <ThemedPanelIcon icon={descriptor.icon} size={16} />,
      back: onBack ? { onPress: onBack } : undefined,
      // The sheet is for looking; the full-screen glyph takes the tab out of the sheet and into
      // the switcher, where it gets its composer back.
      actions: sheet.policy.openAsTab ? (
        <SheetHeaderIconButton
          icon={Maximize2}
          accessibilityLabel={t("workspace.sheet.openAsTab")}
          onPress={handleOpenAsTab}
          testID="sheet-tab-open-as-tab"
        />
      ) : undefined,
    }),
    [descriptor.icon, descriptor.label, handleOpenAsTab, onBack, sheet.policy.openAsTab, t],
  );

  const tabDescriptor = useMemo<WorkspaceTabDescriptor>(
    () => ({
      key: tab.tabId,
      tabId: tab.tabId,
      kind: tab.target.kind,
      target: tab.target,
      state: tab.state,
    }),
    [tab],
  );
  const { buildContent } = host;
  const content = useMemo(
    () => buildContent(tabDescriptor, onClose),
    [buildContent, onClose, tabDescriptor],
  );
  const exit = useMemo<SheetPaneExit>(() => ({ close: onClose, opener }), [onClose, opener]);
  const isPaneFocused = isTop && host.isWorkspaceFocused;
  useViewedSheetAgent({
    sourceId: `${workspaceKey}:sheet:${tab.tabId}`,
    serverId: host.serverId,
    agentId: isPaneFocused && tab.target.kind === "agent" ? tab.target.agentId : null,
  });

  return (
    <SheetPaneExitContext.Provider value={exit}>
      <View style={styles.pane}>
        {/* The body scrolls on its own, so the header is where the sheet drags from. */}
        <SheetDragArea>
          <SheetHeaderView header={header} onClose={onClose} testID="sheet-tab-header" />
        </SheetDragArea>
        <SheetBottomInset
          style={styles.body}
          role="dialog"
          aria-label={descriptor.label}
          testID="sheet-tab-body"
        >
          <WorkspacePaneContent
            content={content}
            isWorkspaceFocused={host.isWorkspaceFocused}
            isPaneFocused={isPaneFocused}
          />
        </SheetBottomInset>
      </View>
    </SheetPaneExitContext.Provider>
  );
}

/**
 * The agent of the sheet on top is viewed, alongside the pane under it: its timeline catches up
 * and stays live. The workspace only publishes the agents of its panes.
 */
function useViewedSheetAgent({
  sourceId,
  serverId,
  agentId,
}: {
  sourceId: string;
  serverId: string;
  agentId: string | null;
}) {
  const viewedTimelineSync = useSessionStore(
    (state) => state.sessions[serverId]?.viewedTimelineSync ?? null,
  );
  useEffect(() => {
    if (!agentId) return;
    void getHostRuntimeStore()
      .prepareAgentTimeline(serverId, agentId)
      .catch(() => undefined);
  }, [agentId, serverId]);
  useLayoutEffect(() => {
    if (!agentId || !viewedTimelineSync) return;
    viewedTimelineSync.replaceVisibleAgentIds(sourceId, [agentId]);
    return () => viewedTimelineSync.replaceVisibleAgentIds(sourceId, []);
  }, [agentId, sourceId, viewedTimelineSync]);
}

/**
 * Leaves the sheet the calling pane is shown in, if any, on the way to `destination`. Answers
 * whether closing the sheet already lands there, so the caller navigates only when it does not.
 */
export function useLeaveSheet(): (destination: WorkspaceTabTarget) => boolean {
  const exit = useContext(SheetPaneExitContext);
  return useCallback(
    (destination) => {
      if (!exit) return false;
      exit.close();
      return exit.opener !== null && workspaceTabTargetsEqual(exit.opener, destination);
    },
    [exit],
  );
}

const styles = StyleSheet.create({
  pane: {
    flex: 1,
    minHeight: 0,
  },
  body: {
    flex: 1,
    minHeight: 0,
  },
});
