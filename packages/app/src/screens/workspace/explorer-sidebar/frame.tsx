import { useCallback } from "react";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  FileExplorerCloseGestureContext,
  useCloseFileExplorerGesture,
} from "@/mobile-panels/gestures";
import { useIsMobilePanelActive } from "@/mobile-panels/provider";
import { MobilePanelOverlay } from "@/mobile-panels/presentation";
import { RetainedPanelActivity } from "@/components/retained-panel";
import { resolveExplorerSidebarWidth } from "@/components/explorer-sidebar-layout";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { useExplorerGeometry } from "./geometry";
import type { ExplorerFrameProps } from "./frame-props";
import { HEADER_TOP_PADDING_MOBILE } from "@/constants/layout";
import { WindowLayoutTopInset } from "@/window-layout";

function ExplorerFrameBase({
  children,
  surfaceColor,
  presentation,
  isOpen,
  isWorkspaceActive,
  persistenceKey,
  containerWidth,
}: ExplorerFrameProps) {
  const overlay = presentation === "overlay";
  const settledOpen = useIsMobilePanelActive("file-explorer");
  const active = isWorkspaceActive && (overlay ? settledOpen : isOpen);
  const resizeEnabled = isWorkspaceActive && !overlay && isOpen;
  const { gesture, gestureRef } = useCloseFileExplorerGesture(isWorkspaceActive && overlay);
  const storedWidth = useWorkspaceLayoutStore(
    (state) => state.explorerSidebarWidthByWorkspace[persistenceKey],
  );
  const resize = useWorkspaceLayoutStore((state) => state.resizeExplorerSidebar);
  const onResize = useCallback(
    (width: number) => resize(persistenceKey, width),
    [persistenceKey, resize],
  );
  const geometry = useExplorerGeometry({
    width: resolveExplorerSidebarWidth({ requestedWidth: storedWidth, containerWidth }),
    containerWidth,
    overlay,
    resizeEnabled,
    onResize,
  });
  return (
    <RetainedPanelActivity active={active}>
      <FileExplorerCloseGestureContext value={gestureRef}>
        <MobilePanelOverlay
          panel="file-explorer"
          closeGesture={gesture}
          presentation={presentation}
          dockVisible={isOpen}
          frameStyle={geometry.frameStyle}
          panelStyle={[{ backgroundColor: surfaceColor }, geometry.panelStyle]}
        >
          <WindowLayoutTopInset additionalPadding={overlay ? HEADER_TOP_PADDING_MOBILE : 0} />
          <View style={styles.content}>
            {resizeEnabled ? geometry.resizeHandle : null}
            {children}
          </View>
        </MobilePanelOverlay>
      </FileExplorerCloseGestureContext>
    </RetainedPanelActivity>
  );
}
export const ExplorerFrame = withUnistyles(ExplorerFrameBase, (theme) => ({
  surfaceColor: theme.colors.surfaceSidebar,
}));
const styles = StyleSheet.create({ content: { flex: 1, minHeight: 0 } });
