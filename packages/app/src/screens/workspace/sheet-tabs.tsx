import type { BottomSheetHandleProps } from "@gorhom/bottom-sheet";
import { useIsFocused } from "@react-navigation/native";
import {
  type ComponentType,
  type FC,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { Maximize2 } from "lucide-react-native";
import {
  SheetBackground,
  SheetHandle,
  SheetHeaderIconButton,
  SheetHeaderView,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import {
  IsolatedBottomSheetModal,
  type IsolatedBottomSheetModalRef,
  systemBackPress,
} from "@/components/ui/isolated-bottom-sheet-modal";
import type { PanelIconProps } from "@/panels/panel-registry";
import { getPanelRegistration } from "@/panels/panel-registry";
import { ensurePanelsRegistered } from "@/panels/register-panels";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import {
  WorkspacePaneContent,
  type WorkspacePaneContentModel,
} from "@/screens/workspace/workspace-pane-content";
import { useWorkspaceLayoutStore, type SheetTab } from "@/stores/workspace-layout-store";

const SNAP_POINTS = ["92%"];
const NO_SHEETS: readonly SheetTab[] = [];

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

interface SheetTabHandleValue {
  header: SheetHeader;
  onClose: () => void;
}

/**
 * The sheet's handle, showing its header. Gorhom takes `handleComponent` as a component type and
 * renders it on the far side of the portal: a new function per render would remount the header on
 * every change, and no context from here reaches it. So each sheet gets one handle component for
 * its lifetime, which reads the header through a store the sheet keeps current.
 */
function useSheetTabHandle(value: SheetTabHandleValue): FC<BottomSheetHandleProps> {
  const [store] = useState(() => createStore<SheetTabHandleValue>(() => value));
  useEffect(() => store.setState(value, true), [store, value]);
  const [Handle] = useState(
    () =>
      function SheetTabHandle(props: BottomSheetHandleProps) {
        const { header, onClose } = useStore(store);
        return (
          <SheetHandle {...props}>
            <SheetHeaderView header={header} onClose={onClose} testID="sheet-tab-header" />
          </SheetHandle>
        );
      },
  );
  return Handle;
}

export interface SheetTabsProps {
  workspaceKey: string | null;
  serverId: string;
  workspaceId: string;
  isWorkspaceFocused: boolean;
  buildContent: (tab: WorkspaceTabDescriptor) => WorkspacePaneContentModel;
  /** The workspace's ordinary tab close, including its unsaved-changes guard. */
  onCloseTab: (tabId: string) => Promise<void>;
}

interface SheetTabSheetProps extends Omit<SheetTabsProps, "workspaceKey" | "onCloseTab"> {
  sheet: SheetTab;
  /** Only the top sheet's pane is focused and answers Android Back; the ones below wait their turn. */
  isTop: boolean;
  /** Runs the guarded close and resolves to whether the tab is still open. */
  onClose: (tabId: string) => Promise<boolean>;
  onOpenAsTab: (tabId: string) => void;
}

/**
 * The workspace's sheet tabs, one sheet each, on the app-wide sheet stack. They present from inside
 * the workspace's `SheetHostScope`, so each panel keeps every context an ordinary pane has, and a
 * sheet opened from any other sheet (a subagent chosen from the subagents list, say) lands on top of
 * it and uncovers it on close. The shared sheet parts (`SheetBackground`, `SheetHandle`,
 * `SheetHeaderView`) keep them looking and dragging like every other sheet.
 */
export function SheetTabs({ workspaceKey, onCloseTab, ...rest }: SheetTabsProps) {
  const sheets = useWorkspaceLayoutStore((state) =>
    workspaceKey ? (state.sheetsByWorkspace[workspaceKey] ?? NO_SHEETS) : NO_SHEETS,
  );
  const openSheetAsTab = useWorkspaceLayoutStore((state) => state.openSheetAsTab);
  const handleOpenAsTab = useCallback(
    (tabId: string) => {
      if (workspaceKey) openSheetAsTab(workspaceKey, tabId);
    },
    [openSheetAsTab, workspaceKey],
  );
  const handleClose = useCallback(
    async (tabId: string) => {
      await onCloseTab(tabId);
      // A declined unsaved-changes prompt leaves the tab in its sheet.
      const open = workspaceKey
        ? useWorkspaceLayoutStore.getState().sheetsByWorkspace[workspaceKey]
        : undefined;
      return open?.some((sheet) => sheet.tab.tabId === tabId) ?? false;
    },
    [onCloseTab, workspaceKey],
  );
  return (
    <>
      {sheets.map((sheet, index) => (
        <SheetTabSheet
          // Keyed by tab id and kind, so the registration and its descriptor hook stay fixed.
          key={`${sheet.tab.tabId}:${sheet.tab.target.kind}`}
          {...rest}
          sheet={sheet}
          isTop={index === sheets.length - 1}
          onClose={handleClose}
          onOpenAsTab={handleOpenAsTab}
        />
      ))}
    </>
  );
}

function SheetTabSheet({
  sheet,
  isTop,
  serverId,
  workspaceId,
  isWorkspaceFocused,
  buildContent,
  onClose,
  onOpenAsTab,
}: SheetTabSheetProps) {
  const { t } = useTranslation();
  const { tab } = sheet;
  const sheetRef = useRef<IsolatedBottomSheetModalRef>(null);
  const isScreenFocused = useIsFocused();
  ensurePanelsRegistered();
  const registration = getPanelRegistration(tab.target.kind);
  if (!registration) {
    throw new Error(`No panel registration for kind: ${tab.target.kind}`);
  }
  const descriptor = registration.useDescriptor(tab.target as never, {
    serverId,
    workspaceId,
    tabId: tab.tabId,
  });

  // The sheet lives as long as its store entry: it presents on mount, and unmounting takes it off
  // the stack, which uncovers the sheet below. Gorhom slides an unmounting sheet down and still
  // reports that as `onChange(-1)`, which must not read as the user closing it: the store already
  // moved on, and the same tab id may now be a pane tab (Open as tab).
  const unmounted = useRef(false);
  useEffect(() => {
    sheetRef.current?.present();
    return () => {
      unmounted.current = true;
    };
  }, []);

  // Every close path (drag, backdrop, Close, Back) slides the sheet down first; `onChange(-1)` then
  // runs the one guarded close. The sheet keeps its content through the close, so a declined
  // unsaved-changes prompt only has to bring it back up.
  const close = useCallback(() => sheetRef.current?.close(), []);
  const handleChange = useCallback(
    (index: number) => {
      if (index !== -1 || unmounted.current) return;
      void onClose(tab.tabId).then((stillOpen) => {
        if (stillOpen) sheetRef.current?.snapToIndex(0);
        return stillOpen;
      });
    },
    [onClose, tab.tabId],
  );
  // Hidden workspaces stay mounted in the deck and under Settings; only the visible one owns Back.
  const ownsBackPress = isTop && isWorkspaceFocused && isScreenFocused;
  useEffect(() => {
    if (!ownsBackPress) return;
    return systemBackPress.subscribe(() => {
      close();
      return true;
    });
  }, [close, ownsBackPress]);

  const handleOpenAsTab = useCallback(() => onOpenAsTab(tab.tabId), [onOpenAsTab, tab.tabId]);
  const header = useMemo<SheetHeader>(
    () => ({
      title: descriptor.label,
      leading: <ThemedPanelIcon icon={descriptor.icon} size={16} />,
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
    [descriptor.icon, descriptor.label, handleOpenAsTab, sheet.policy.openAsTab, t],
  );
  const handleValue = useMemo<SheetTabHandleValue>(
    () => ({ header, onClose: close }),
    [close, header],
  );
  // The header is the sheet's handle: the panel scrolls on its own, so dragging the content would
  // fight it, and the header is where people reach to pull the sheet down.
  const SheetTabHandle = useSheetTabHandle(handleValue);

  return (
    <IsolatedBottomSheetModal
      ref={sheetRef}
      contextBridge={null}
      snapPoints={SNAP_POINTS}
      enableDynamicSizing={false}
      enablePanDownToClose
      enableContentPanningGesture={false}
      enableDismissOnClose={false}
      backgroundComponent={SheetBackground}
      handleComponent={SheetTabHandle}
      backdropOpacity={0.45}
      onChange={handleChange}
      accessible={false}
    >
      {/* A covered sheet stays as live as the pane under it; only focus follows the top sheet. */}
      <SheetTabBody
        tab={tab}
        label={descriptor.label}
        isPaneFocused={isTop && isWorkspaceFocused}
        isWorkspaceFocused={isWorkspaceFocused}
        buildContent={buildContent}
      />
    </IsolatedBottomSheetModal>
  );
}

function SheetTabBody({
  tab,
  label,
  isPaneFocused,
  isWorkspaceFocused,
  buildContent,
}: {
  tab: SheetTab["tab"];
  label: string;
  /** Only the top sheet's pane is focused; the ones below are covered. */
  isPaneFocused: boolean;
  isWorkspaceFocused: boolean;
  buildContent: (tab: WorkspaceTabDescriptor) => WorkspacePaneContentModel;
}) {
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
  // The sheet reaches the bottom of the screen, so it owns the system navigation inset.
  const { bottom: bottomInset } = useSafeAreaInsets();
  const contentStyle = useMemo(
    () => [styles.content, { paddingBottom: bottomInset }],
    [bottomInset],
  );

  return (
    <View style={contentStyle} role="dialog" aria-label={label} testID="sheet-tab-body">
      <WorkspacePaneContent
        content={content}
        isWorkspaceFocused={isWorkspaceFocused}
        isPaneFocused={isPaneFocused}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    flex: 1,
    minHeight: 0,
  },
});
