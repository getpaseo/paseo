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
  bindSelectedWorkspaceGit,
  WorkspaceGitBoundary,
  type WorkspaceGitClient,
} from "@/git/workspace-git";
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

function useCompactWorkspaceGit(
  client: ReturnType<typeof useHostRuntimeClient>,
  workspaceId: string | null | undefined,
  cwd: string | null | undefined,
): WorkspaceGitClient | null {
  return useMemo(() => {
    if (!client || !workspaceId || !cwd) {
      return null;
    }
    return bindSelectedWorkspaceGit(client, { kind: "selected", workspaceId, cwd });
  }, [client, cwd, workspaceId]);
}

function useCompactExplorerModel({
  enabled,
  isExplorerOpen,
  selection,
  workspace,
  isGit,
  showMobileAgent,
}: {
  enabled: boolean;
  isExplorerOpen: boolean;
  selection: Parameters<typeof resolveCompactExplorerSidebarHostModel>[0]["selection"];
  workspace: Parameters<typeof resolveCompactExplorerSidebarHostModel>[0]["workspace"];
  isGit: boolean;
  showMobileAgent: () => void;
}): CompactExplorerSidebarHostModel | null {
  const retainedModelRef = useRef<CompactExplorerSidebarHostModel | null>(null);
  const resolvedModel = useMemo(
    () =>
      resolveCompactExplorerSidebarHostModel({
        previous: isExplorerOpen ? retainedModelRef.current : null,
        selection,
        workspace,
        isGit,
      }),
    [isExplorerOpen, isGit, selection, workspace],
  );
  useEffect(() => {
    if (!selection) {
      retainedModelRef.current = null;
      if (enabled && isExplorerOpen) showMobileAgent();
      return;
    }
    if (!isExplorerOpen) {
      retainedModelRef.current = null;
      return;
    }
    if (resolvedModel) retainedModelRef.current = resolvedModel;
  }, [enabled, isExplorerOpen, resolvedModel, selection, showMobileAgent]);

  if (!selection) return null;
  return resolvedModel ?? (isExplorerOpen ? retainedModelRef.current : null);
}

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

function useActiveCompactExplorerSidebarModel(enabled: boolean): {
  model: CompactExplorerSidebarHostModel | null;
  workspaceGit: WorkspaceGitClient | null;
} {
  const selection = useActiveWorkspaceSelection();
  const workspace = useWorkspace(selection?.serverId ?? null, selection?.workspaceId ?? null);
  const isExplorerOpen = usePanelStore((state) =>
    selectIsFileExplorerOpen(state, { isCompact: true }),
  );
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  const client = useHostRuntimeClient(selection?.serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(selection?.serverId ?? "");
  const workspaceGit = useCompactWorkspaceGit(
    client,
    selection?.workspaceId,
    workspace?.workspaceDirectory,
  );
  const { checkoutQuery } = useWorkspaceCheckoutStatus({
    workspaceGit,
    isConnected,
    isRouteFocused: enabled && selection !== null,
    normalizedServerId: selection?.serverId ?? "",
    normalizedWorkspaceId: selection?.workspaceId ?? "",
    workspaceDirectory: workspace?.workspaceDirectory || null,
  });
  const model = useCompactExplorerModel({
    enabled,
    isExplorerOpen,
    selection,
    workspace,
    isGit: checkoutQuery.data?.isGit ?? false,
    showMobileAgent,
  });

  return {
    model,
    workspaceGit,
  };
}

interface CompactExplorerSidebarHostProps {
  children: ReactNode;
  enabled: boolean;
}

export function CompactExplorerSidebarHost({ children, enabled }: CompactExplorerSidebarHostProps) {
  const { model, workspaceGit } = useActiveCompactExplorerSidebarModel(enabled);
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
        enabled={enabled && Boolean(model?.workspaceRoot) && Boolean(workspaceGit)}
        onOpenExplorer={handleOpenExplorer}
      >
        {children}
      </CompactExplorerOpenGestureSurface>
      <WorkspaceGitBoundary workspaceGit={workspaceGit}>
        {enabled && model && workspaceGit ? (
          <CompactExplorerSidebar
            serverId={model.serverId}
            workspaceId={model.workspaceId}
            workspaceRoot={model.workspaceRoot}
            isGit={model.isGit}
            onOpenFile={handleOpenFile}
          />
        ) : null}
      </WorkspaceGitBoundary>
    </>
  );
}

const styles = {
  fill: {
    flex: 1,
  },
} as const;
