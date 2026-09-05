import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useWorkspace } from "@/stores/session-store-hooks";
import {
  CompactExplorerSidebar,
  NativeExplorerSidebarDock,
} from "@/components/compact-explorer-sidebar";
import { useOpenFileExplorerGesture } from "@/mobile-panels/gestures";
import { useIsMobilePanelActive } from "@/mobile-panels/provider";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { usePanelStore } from "@/stores/panel-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { useWorkspaceCheckoutStatus } from "@/screens/workspace/use-workspace-checkout-status";
import { openWorkspaceFileFromExplorer } from "@/screens/workspace/workspace-file-open-command";
import { isWeb } from "@/constants/platform";
import { DiffDocumentWorkspaceCacheProvider } from "@/git/diff-document/workspace-cache";
import {
  resolveCompactExplorerSidebarHostModel,
  type CompactExplorerSidebarHostModel,
} from "@/components/compact-explorer-sidebar-host-state";

interface CompactExplorerOpenGestureSurfaceProps {
  children: ReactNode;
  enabled: boolean;
  onOpenExplorer: () => void;
}

const COMPACT_WEB_GESTURE_TOUCH_ACTION = isWeb ? "auto" : "pan-y";

function CompactExplorerOpenGestureSurface({
  children,
  enabled,
  onOpenExplorer,
}: CompactExplorerOpenGestureSurfaceProps) {
  const explorerOpenGesture = useOpenFileExplorerGesture({
    enabled,
    onOpen: onOpenExplorer,
  });

  return (
    <GestureDetector gesture={explorerOpenGesture} touchAction={COMPACT_WEB_GESTURE_TOUCH_ACTION}>
      <View style={styles.fill}>{children}</View>
    </GestureDetector>
  );
}

function useActiveCompactExplorerSidebarModel(
  enabled: boolean,
): CompactExplorerSidebarHostModel | null {
  const selection = useActiveWorkspaceSelection();
  const workspace = useWorkspace(selection?.serverId ?? null, selection?.workspaceId ?? null);
  const isExplorerActive = useIsMobilePanelActive("file-explorer");
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  const client = useHostRuntimeClient(selection?.serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(selection?.serverId ?? "");
  const retainedModelRef = useRef<CompactExplorerSidebarHostModel | null>(null);
  const { checkoutQuery } = useWorkspaceCheckoutStatus({
    client,
    isConnected,
    isRouteFocused: enabled && selection !== null,
    normalizedServerId: selection?.serverId ?? "",
    normalizedWorkspaceId: selection?.workspaceId ?? "",
    workspaceDirectory: workspace?.workspaceDirectory || null,
  });
  const resolvedModel = useMemo(
    () =>
      resolveCompactExplorerSidebarHostModel({
        previous: isExplorerActive ? retainedModelRef.current : null,
        selection,
        workspace,
        isGit: checkoutQuery.data?.isGit ?? false,
      }),
    [checkoutQuery.data?.isGit, isExplorerActive, selection, workspace],
  );

  useEffect(() => {
    if (!selection) {
      retainedModelRef.current = null;
      if (enabled && isExplorerActive) {
        showMobileAgent();
      }
      return;
    }
    if (!isExplorerActive) {
      retainedModelRef.current = null;
      return;
    }
    if (resolvedModel) {
      retainedModelRef.current = resolvedModel;
    }
  }, [enabled, isExplorerActive, resolvedModel, selection, showMobileAgent]);

  return selection ? (resolvedModel ?? (isExplorerActive ? retainedModelRef.current : null)) : null;
}

interface CompactExplorerSidebarHostProps {
  children: ReactNode;
  enabled: boolean;
  presentation: "overlay" | "dock";
}

export function CompactExplorerSidebarHost({
  children,
  enabled,
  presentation,
}: CompactExplorerSidebarHostProps) {
  const model = useActiveCompactExplorerSidebarModel(enabled);
  const [containerWidth, setContainerWidth] = useState(0);
  const openCompactFileExplorer = usePanelStore((state) => state.openCompactFileExplorer);
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  const openTab = useWorkspaceLayoutStore((state) => state.openTab);
  const openWorkspaceTabInFocusedPane = useCallback(
    (workspaceKey: string, target: WorkspaceTabTarget) =>
      openTab({ workspaceKey, target, intent: "reveal" }),
    [openTab],
  );
  const focusWorkspaceTab = useWorkspaceLayoutStore((state) => state.focusTab);

  const handleOpenExplorer = useCallback(() => {
    if (!model?.workspaceRoot) {
      return;
    }
    openCompactFileExplorer({
      serverId: model.serverId,
      cwd: model.workspaceRoot,
      isGit: model.isGit,
    });
  }, [model, openCompactFileExplorer]);

  const handleOpenFile = useCallback(
    (filePath: string) => {
      if (!model) {
        return;
      }
      openWorkspaceFileFromExplorer({
        filePath,
        persistenceKey: model.persistenceKey,
        closeExplorerAfterOpen: presentation === "overlay",
        showMobileAgent,
        openWorkspaceTabInFocusedPane,
        focusWorkspaceTab,
      });
    },
    [focusWorkspaceTab, model, openWorkspaceTabInFocusedPane, presentation, showMobileAgent],
  );

  const handleContainerLayout = useCallback((event: LayoutChangeEvent) => {
    const nextWidth = event.nativeEvent.layout.width;
    setContainerWidth((current) => (current === nextWidth ? current : nextWidth));
  }, []);

  const explorer =
    enabled && model ? (
      <DiffDocumentWorkspaceCacheProvider key={model.persistenceKey}>
        {presentation === "dock" ? (
          <NativeExplorerSidebarDock
            serverId={model.serverId}
            workspaceId={model.workspaceId}
            workspaceRoot={model.workspaceRoot}
            isGit={model.isGit}
            persistenceKey={model.persistenceKey}
            containerWidth={containerWidth}
            onOpenFile={handleOpenFile}
          />
        ) : (
          <CompactExplorerSidebar
            serverId={model.serverId}
            workspaceId={model.workspaceId}
            workspaceRoot={model.workspaceRoot}
            isGit={model.isGit}
            onOpenFile={handleOpenFile}
          />
        )}
      </DiffDocumentWorkspaceCacheProvider>
    ) : null;

  if (presentation === "dock") {
    return (
      <View style={styles.row} onLayout={handleContainerLayout}>
        <View style={styles.fill}>{children}</View>
        {explorer}
      </View>
    );
  }

  return (
    <>
      <CompactExplorerOpenGestureSurface
        enabled={enabled && Boolean(model?.workspaceRoot)}
        onOpenExplorer={handleOpenExplorer}
      >
        {children}
      </CompactExplorerOpenGestureSurface>
      {explorer}
    </>
  );
}

const styles = {
  fill: {
    flex: 1,
  },
  row: {
    flex: 1,
    flexDirection: "row",
  },
} as const;
