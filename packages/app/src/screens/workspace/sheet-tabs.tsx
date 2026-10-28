import { useIsFocused } from "expo-router/react-navigation";
import { useCallback, useEffect, useRef } from "react";
import {
  FULL_SHEET_SNAP_POINTS,
  SheetBackground,
  SheetHandle,
} from "@/components/adaptive-modal-sheet";
import {
  IsolatedBottomSheetModal,
  type IsolatedBottomSheetModalRef,
  systemBackPress,
} from "@/components/ui/isolated-bottom-sheet-modal";
import {
  SheetPane,
  useSheetPaneBridge,
  useSheetPaneHost,
  useSheetPaneHostIfAny,
} from "@/screens/workspace/sheet-pane";
import { useWorkspaceLayoutStore, type SheetTab } from "@/stores/workspace-layout-store";

const NO_SHEETS: readonly SheetTab[] = [];

export interface SheetTabsProps {
  /** The workspace's ordinary tab close, including its unsaved-changes guard. */
  onCloseTab: (tabId: string) => Promise<void>;
}

interface SheetTabSheetProps {
  sheet: SheetTab;
  /** Only the top sheet answers Android Back; the ones below wait their turn. */
  isTop: boolean;
  /** Runs the guarded close and resolves to whether the tab is still open. */
  onClose: (tabId: string) => Promise<boolean>;
}

/**
 * The workspace's sheet tabs, one sheet each, on the app-wide sheet stack. Their environment
 * crosses into the app overlay host so compact sheets cover both sidebars, and a sheet opened
 * from another one lands on top of it and uncovers it on close.
 */
export function SheetTabs({ onCloseTab }: SheetTabsProps) {
  const host = useSheetPaneHostIfAny();
  return host ? (
    <WorkspaceSheetTabs workspaceKey={host.workspaceKey} onCloseTab={onCloseTab} />
  ) : null;
}

function WorkspaceSheetTabs({
  workspaceKey,
  onCloseTab,
}: SheetTabsProps & { workspaceKey: string }) {
  const sheets = useWorkspaceLayoutStore(
    (state) => state.sheetsByWorkspace[workspaceKey] ?? NO_SHEETS,
  );
  const handleClose = useCallback(
    async (tabId: string) => {
      await onCloseTab(tabId);
      // A declined unsaved-changes prompt leaves the tab in its sheet.
      const open = useWorkspaceLayoutStore.getState().sheetsByWorkspace[workspaceKey];
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
          sheet={sheet}
          isTop={index === sheets.length - 1}
          onClose={handleClose}
        />
      ))}
    </>
  );
}

function SheetTabSheet({ sheet, isTop, onClose }: SheetTabSheetProps) {
  const { tab } = sheet;
  const sheetRef = useRef<IsolatedBottomSheetModalRef>(null);
  const isScreenFocused = useIsFocused();
  const { isWorkspaceFocused } = useSheetPaneHost();
  const contextBridge = useSheetPaneBridge();

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

  return (
    <IsolatedBottomSheetModal
      ref={sheetRef}
      contextBridge={contextBridge}
      snapPoints={FULL_SHEET_SNAP_POINTS}
      enableDynamicSizing={false}
      enablePanDownToClose
      // The pane scrolls on its own; the sheet drags from its handle and header.
      enableContentPanningGesture={false}
      enableDismissOnClose={false}
      backgroundComponent={SheetBackground}
      handleComponent={SheetHandle}
      backdropOpacity={0.45}
      onChange={handleChange}
      accessible={false}
    >
      <SheetPane sheet={sheet} onClose={close} isTop={isTop} />
    </IsolatedBottomSheetModal>
  );
}
