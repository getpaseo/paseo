import BottomSheet, {
  BottomSheetBackdrop,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet";
import { useIsFocused } from "@react-navigation/native";
import { type ComponentType, useCallback, useEffect, useMemo, useRef } from "react";
import { BackHandler, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { SheetHeaderView } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { isNative } from "@/constants/platform";
import type { PanelIconProps } from "@/panels/panel-registry";
import { getPanelRegistration } from "@/panels/panel-registry";
import { ensurePanelsRegistered } from "@/panels/register-panels";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import {
  WorkspacePaneContent,
  type WorkspacePaneContentModel,
} from "@/screens/workspace/workspace-pane-content";
import { useWorkspaceLayoutStore, type WorkspaceSheet } from "@/stores/workspace-layout-store";

const SNAP_POINTS = ["92%"];

const ThemedBottomSheet = withUnistyles(BottomSheet, (theme) => ({
  backgroundStyle: {
    backgroundColor: theme.colors.surface0,
    borderTopLeftRadius: theme.borderRadius["2xl"],
    borderTopRightRadius: theme.borderRadius["2xl"],
  },
  handleIndicatorStyle: {
    backgroundColor: theme.colors.palette.zinc[600],
  },
}));

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

function renderBackdrop(props: BottomSheetBackdropProps) {
  return (
    <BottomSheetBackdrop
      {...props}
      appearsOnIndex={0}
      disappearsOnIndex={-1}
      opacity={0.45}
      pressBehavior="close"
    />
  );
}

export interface WorkspaceSheetHostProps {
  workspaceKey: string | null;
  serverId: string;
  workspaceId: string;
  isWorkspaceFocused: boolean;
  buildContent: (tab: WorkspaceTabDescriptor) => WorkspacePaneContentModel;
  /** The workspace's ordinary tab close, including its unsaved-changes guard. */
  onCloseTab: (tabId: string) => Promise<void>;
}

interface WorkspaceSheetPresentationProps extends Omit<
  WorkspaceSheetHostProps,
  "workspaceKey" | "onCloseTab"
> {
  sheet: WorkspaceSheet;
  onClose: () => Promise<void>;
  onOpenAsTab: () => void;
}

/**
 * Hosts the workspace's sheet tab over the compact tab strip. It renders in the workspace tree,
 * not through a portal, so the panel keeps every context an ordinary pane has.
 */
export function WorkspaceSheetHost({ workspaceKey, onCloseTab, ...rest }: WorkspaceSheetHostProps) {
  const sheet = useWorkspaceLayoutStore((state) =>
    workspaceKey ? (state.sheetByWorkspace[workspaceKey] ?? null) : null,
  );
  const openSheetAsTab = useWorkspaceLayoutStore((state) => state.openSheetAsTab);
  const sheetTabId = sheet?.tab.tabId ?? null;
  const handleClose = useCallback(async () => {
    if (sheetTabId) await onCloseTab(sheetTabId);
  }, [onCloseTab, sheetTabId]);
  const handleOpenAsTab = useCallback(() => {
    if (workspaceKey) openSheetAsTab(workspaceKey);
  }, [openSheetAsTab, workspaceKey]);
  if (!sheet) return null;
  return (
    <WorkspaceSheetPresentation
      {...rest}
      sheet={sheet}
      onClose={handleClose}
      onOpenAsTab={handleOpenAsTab}
    />
  );
}

function WorkspaceSheetPresentation({
  sheet,
  serverId,
  workspaceId,
  isWorkspaceFocused,
  buildContent,
  onClose,
  onOpenAsTab,
}: WorkspaceSheetPresentationProps) {
  const sheetRef = useRef<BottomSheet>(null);
  const isScreenFocused = useIsFocused();
  const ownsBackPress = isNative && isWorkspaceFocused && isScreenFocused;
  const handleChange = useCallback(
    (index: number) => {
      if (index !== -1) return;
      // A declined close (unsaved changes) leaves the tab in the sheet, so bring it back up.
      void onClose().then(() => sheetRef.current?.snapToIndex(0));
    },
    [onClose],
  );
  useEffect(() => {
    // Hidden workspaces stay mounted in the deck and under Settings; only the visible one owns back.
    if (!ownsBackPress) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      void onClose();
      return true;
    });
    return () => subscription.remove();
  }, [onClose, ownsBackPress]);

  return (
    <View style={styles.host} pointerEvents="box-none">
      <ThemedBottomSheet
        ref={sheetRef}
        index={0}
        snapPoints={SNAP_POINTS}
        enableDynamicSizing={false}
        enablePanDownToClose
        enableContentPanningGesture={false}
        backdropComponent={renderBackdrop}
        onChange={handleChange}
      >
        <WorkspaceSheetBody
          key={`${sheet.tab.tabId}:${sheet.tab.target.kind}`}
          sheet={sheet}
          serverId={serverId}
          workspaceId={workspaceId}
          isWorkspaceFocused={isWorkspaceFocused}
          buildContent={buildContent}
          onClose={onClose}
          onOpenAsTab={onOpenAsTab}
        />
      </ThemedBottomSheet>
    </View>
  );
}

function WorkspaceSheetBody({
  sheet,
  serverId,
  workspaceId,
  isWorkspaceFocused,
  buildContent,
  onClose,
  onOpenAsTab,
}: WorkspaceSheetPresentationProps) {
  const { t } = useTranslation();
  const { tab } = sheet;
  ensurePanelsRegistered();
  const registration = getPanelRegistration(tab.target.kind);
  if (!registration) {
    throw new Error(`No panel registration for kind: ${tab.target.kind}`);
  }
  // The body is keyed by tab id and kind, so the registration and its descriptor hook stay fixed.
  const descriptor = registration.useDescriptor(tab.target as never, {
    serverId,
    workspaceId,
    tabId: tab.tabId,
  });
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
  const content = useMemo(() => buildContent(tabDescriptor), [buildContent, tabDescriptor]);
  const handleClose = useCallback(() => {
    void onClose();
  }, [onClose]);
  // The sheet reaches the bottom of the screen, so it owns the system navigation inset.
  const { bottom: bottomInset } = useSafeAreaInsets();
  const contentStyle = useMemo(
    () => [styles.content, { paddingBottom: bottomInset }],
    [bottomInset],
  );
  const header = useMemo(
    () => ({
      title: descriptor.label,
      leading: <ThemedPanelIcon icon={descriptor.icon} size={16} />,
      actions: sheet.policy.openAsTab ? (
        <Button size="sm" variant="secondary" onPress={onOpenAsTab}>
          {t("workspace.sheet.openAsTab")}
        </Button>
      ) : undefined,
    }),
    [descriptor.icon, descriptor.label, onOpenAsTab, sheet.policy.openAsTab, t],
  );

  return (
    <View style={styles.body} role="dialog" aria-label={descriptor.label}>
      <SheetHeaderView header={header} onClose={handleClose} />
      <View style={contentStyle}>
        <WorkspacePaneContent
          content={content}
          isWorkspaceFocused={isWorkspaceFocused}
          isPaneFocused={isWorkspaceFocused}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    ...StyleSheet.absoluteFillObject,
  },
  body: {
    flex: 1,
    minHeight: 0,
  },
  content: {
    flex: 1,
    minHeight: 0,
  },
});
