import { type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import { View } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useWorkspace } from "@/stores/session-store-hooks";
import { CompactExplorerSidebar } from "@/components/explorer-sidebar";
import { useOpenFileExplorerGesture } from "@/mobile-panels/gestures";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { selectIsFileExplorerOpen, usePanelStore } from "@/stores/panel-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { useWorkspaceCheckoutStatus } from "@/screens/workspace/use-workspace-checkout-status";
import { openWorkspaceFileFromExplorer } from "@/screens/workspace/workspace-file-open-command";
import { isWeb } from "@/constants/platform";
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
  const isExplorerOpen = usePanelStore((state) =>
    selectIsFileExplorerOpen(state, { isCompact: true }),
  );
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
        previous: isExplorerOpen ? retainedModelRef.current : null,
        selection,
        workspace,
        isGit: checkoutQuery.data?.isGit ?? false,
      }),
    [checkoutQuery.data?.isGit, isExplorerOpen, selection, workspace],
  );

  useEffect(() => {
    if (!selection) {
      retainedModelRef.current = null;
      if (enabled && isExplorerOpen) {
        showMobileAgent();
      }
      return;
    }
    if (!isExplorerOpen) {
      retainedModelRef.current = null;
      return;
    }
    if (resolvedModel) {
      retainedModelRef.current = resolvedModel;
    }
  }, [enabled, isExplorerOpen, resolvedModel, selection, showMobileAgent]);

  return selection ? (resolvedModel ?? (isExplorerOpen ? retainedModelRef.current : null)) : null;
}

interface CompactExplorerSidebarHostProps {
  children: ReactNode;
  enabled: boolean;
}

export function CompactExplorerSidebarHost({ children, enabled }: CompactExplorerSidebarHostProps) {
  const model = useActiveCompactExplorerSidebarModel(enabled);
  const openFileExplorerForCheckout = usePanelStore((state) => state.openFileExplorerForCheckout);
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  const openWorkspaceTabFocused = useWorkspaceLayoutStore((state) => state.openTabFocused);
  const focusWorkspaceTab = useWorkspaceLayoutStore((state) => state.focusTab);

  const handleOpenExplorer = useCallback(() => {
    if (!model?.workspaceRoot) {
      return;
    }
    openFileExplorerForCheckout({
      isCompact: true,
      checkout: {
        serverId: model.serverId,
        cwd: model.workspaceRoot,
        isGit: model.isGit,
      },
    });
  }, [model, openFileExplorerForCheckout]);

  const handleOpenFile = useCallback(
    (filePath: string) => {
      if (!model) {
        return;
      }
      openWorkspaceFileFromExplorer({
        filePath,
        persistenceKey: model.persistenceKey,
        showMobileAgent,
        openWorkspaceTabFocused,
        focusWorkspaceTab,
      });
    },
    [focusWorkspaceTab, model, openWorkspaceTabFocused, showMobileAgent],
  );

  return (
    <>
      <CompactExplorerOpenGestureSurface
        enabled={enabled && Boolean(model?.workspaceRoot)}
        onOpenExplorer={handleOpenExplorer}
      >
        {children}
      </CompactExplorerOpenGestureSurface>
      {enabled && model ? (
        <CompactExplorerSidebar
          serverId={model.serverId}
          workspaceId={model.workspaceId}
          workspaceRoot={model.workspaceRoot}
          isGit={model.isGit}
          onOpenFile={handleOpenFile}
        />
      ) : null}
    </>
  );
}

const styles = {
  fill: {
    flex: 1,
  },
} as const;
