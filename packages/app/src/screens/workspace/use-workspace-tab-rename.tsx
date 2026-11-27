import { useCallback, useState } from "react";
import { type QueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ListTerminalsResponse } from "@getpaseo/protocol/messages";
import { useTranslation } from "react-i18next";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import { WorkspaceTabPresentationResolver } from "@/screens/workspace/workspace-tab-presentation";
import { canRenameWorkspaceTab } from "@/screens/workspace/workspace-tab-menu";

/**
 * Agents and terminals are renamed on the daemon, so the name follows them everywhere. Every
 * other tab keeps the name in the workspace layout, on the tab itself.
 */
type RenamingTabState =
  | { kind: "terminal" | "agent"; id: string; currentTitle: string }
  | { kind: "tab"; id: string; currentTitle: string; tab: WorkspaceTabDescriptor };

interface UseWorkspaceTabRenameInput {
  client: DaemonClient | null;
  normalizedServerId: string;
  workspaceKey: string | null;
  queryClient: QueryClient;
  terminalsData: ListTerminalsResponse["payload"] | undefined;
  terminalsQueryKey: readonly unknown[];
}

interface UseWorkspaceTabRenameResult {
  renamingTab: RenamingTabState | null;
  handleRenameTab: (tab: WorkspaceTabDescriptor) => void;
  handleRenameModalSubmit: (nextTitle: string) => Promise<void>;
  handleRenameModalClose: () => void;
}

export function useWorkspaceTabRename(
  input: UseWorkspaceTabRenameInput,
): UseWorkspaceTabRenameResult {
  const { client, normalizedServerId, workspaceKey, queryClient, terminalsData, terminalsQueryKey } =
    input;
  const { t } = useTranslation();
  const [renamingTab, setRenamingTab] = useState<RenamingTabState | null>(null);

  const handleRenameTab = useCallback(
    (tab: WorkspaceTabDescriptor) => {
      if (tab.target.kind === "terminal") {
        const { terminalId } = tab.target;
        const terminal = terminalsData?.terminals.find((entry) => entry.id === terminalId) ?? null;
        const currentTitle = terminal?.title ?? terminal?.name ?? "";
        setRenamingTab({ kind: "terminal", id: terminalId, currentTitle });
        return;
      }
      if (tab.target.kind === "agent") {
        const { agentId } = tab.target;
        const agent =
          useSessionStore.getState().sessions[normalizedServerId]?.agents?.get(agentId) ?? null;
        const currentTitle = agent?.title ?? "";
        setRenamingTab({ kind: "agent", id: agentId, currentTitle });
        return;
      }
      if (canRenameWorkspaceTab(tab)) {
        setRenamingTab({ kind: "tab", id: tab.tabId, currentTitle: tab.title ?? "", tab });
      }
    },
    [normalizedServerId, terminalsData],
  );

  const handleRenameModalSubmit = useCallback(
    async (nextTitle: string) => {
      if (!renamingTab) return;
      if (renamingTab.kind === "tab") {
        if (!workspaceKey) return;
        useWorkspaceLayoutStore
          .getState()
          .setTabTitle(workspaceKey, renamingTab.id, nextTitle.trim() || null);
        return;
      }
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const trimmed = nextTitle.trim();
      if (renamingTab.kind === "terminal") {
        const result = await client.renameTerminal({
          terminalId: renamingTab.id,
          title: trimmed,
        });
        if (!result.success) {
          throw new Error(result.error ?? "Failed to rename terminal");
        }
        void queryClient.invalidateQueries({ queryKey: terminalsQueryKey });
        return;
      }
      await client.updateAgent(renamingTab.id, { name: trimmed });
      void queryClient.invalidateQueries({
        queryKey: ["sidebarAgentsList", normalizedServerId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["allAgents", normalizedServerId],
      });
    },
    [client, normalizedServerId, queryClient, renamingTab, terminalsQueryKey, t, workspaceKey],
  );

  const handleRenameModalClose = useCallback(() => {
    setRenamingTab(null);
  }, []);

  return {
    renamingTab,
    handleRenameTab,
    handleRenameModalSubmit,
    handleRenameModalClose,
  };
}

export interface WorkspaceTabRenameModalProps {
  renamingTab: RenamingTabState | null;
  serverId: string;
  workspaceId: string;
  onClose: () => void;
  onSubmit: (nextTitle: string) => Promise<void>;
}

export function WorkspaceTabRenameModal({
  renamingTab,
  serverId,
  workspaceId,
  onClose,
  onSubmit,
}: WorkspaceTabRenameModalProps) {
  const { t } = useTranslation();
  if (renamingTab?.kind === "tab") {
    // Resolve the tab's own label without the user's name, to show what clearing the field restores.
    const { title: _custom, ...automatic } = renamingTab.tab;
    return (
      <WorkspaceTabPresentationResolver tab={automatic} serverId={serverId} workspaceId={workspaceId}>
        {(presentation) => (
          <AdaptiveRenameModal
            visible
            title={t("workspace.tabs.menu.renameTab")}
            initialValue={renamingTab.currentTitle || presentation.label}
            placeholder={presentation.label}
            allowEmpty
            submitLabel={t("workspace.tabs.menu.rename")}
            maxLength={200}
            onClose={onClose}
            onSubmit={onSubmit}
            testID={`workspace-tab-rename-modal-tab-${renamingTab.id}`}
          />
        )}
      </WorkspaceTabPresentationResolver>
    );
  }
  const title =
    renamingTab?.kind === "terminal"
      ? t("workspace.tabs.menu.renameTerminal")
      : t("workspace.tabs.menu.renameAgent");
  const initialValue = renamingTab?.currentTitle ?? "";
  const testID = renamingTab
    ? `workspace-tab-rename-modal-${renamingTab.kind}-${renamingTab.id}`
    : undefined;
  return (
    <AdaptiveRenameModal
      visible={renamingTab !== null}
      title={title}
      initialValue={initialValue}
      submitLabel={t("workspace.tabs.menu.rename")}
      maxLength={200}
      onClose={onClose}
      onSubmit={onSubmit}
      testID={testID}
    />
  );
}
