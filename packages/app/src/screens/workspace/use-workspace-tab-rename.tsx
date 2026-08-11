import { useCallback, useState } from "react";
import { type QueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ListTerminalsResponse } from "@getpaseo/protocol/messages";
import { useTranslation } from "react-i18next";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import { useSessionStore } from "@/stores/session-store";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";

interface RenamingTabState {
  kind: "terminal" | "agent" | "file" | "scratch_file";
  id: string;
  currentTitle: string;
}

interface UseWorkspaceTabRenameInput {
  client: DaemonClient | null;
  normalizedServerId: string;
  workspaceKey: string | null;
  renameWorkspaceTab: (workspaceKey: string, tabId: string, title: string) => void;
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
  const {
    client,
    normalizedServerId,
    workspaceKey,
    renameWorkspaceTab,
    queryClient,
    terminalsData,
    terminalsQueryKey,
  } = input;
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
      if (tab.target.kind === "file" || tab.target.kind === "scratch_file") {
        const currentTitle =
          tab.title?.trim() ||
          (tab.target.kind === "file"
            ? (tab.target.path.split("/").findLast(Boolean) ?? tab.target.path)
            : t("workspace.tabs.fallback.file"));
        setRenamingTab({ kind: tab.target.kind, id: tab.tabId, currentTitle });
      }
    },
    [normalizedServerId, t, terminalsData],
  );

  const handleRenameModalSubmit = useCallback(
    async (nextTitle: string) => {
      if (!renamingTab) return;
      const trimmed = nextTitle.trim();
      if (renamingTab.kind === "file" || renamingTab.kind === "scratch_file") {
        if (!workspaceKey) {
          throw new Error(t("workspace.terminal.hostDisconnected"));
        }
        renameWorkspaceTab(workspaceKey, renamingTab.id, trimmed);
        return;
      }
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
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
    [
      client,
      normalizedServerId,
      queryClient,
      renameWorkspaceTab,
      renamingTab,
      terminalsQueryKey,
      t,
      workspaceKey,
    ],
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
  onClose: () => void;
  onSubmit: (nextTitle: string) => Promise<void>;
}

export function WorkspaceTabRenameModal({
  renamingTab,
  onClose,
  onSubmit,
}: WorkspaceTabRenameModalProps) {
  const { t } = useTranslation();
  let title = t("workspace.tabs.menu.renameFile");
  if (renamingTab?.kind === "terminal") {
    title = t("workspace.tabs.menu.renameTerminal");
  } else if (renamingTab?.kind === "agent") {
    title = t("workspace.tabs.menu.renameAgent");
  }
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
