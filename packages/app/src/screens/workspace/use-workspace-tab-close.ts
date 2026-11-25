import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getOpenAgentTabLabel } from "@getpaseo/protocol/agent-labels";
import type { ListTerminalsResponse } from "@getpaseo/protocol/messages";
import { useToast } from "@/contexts/toast-context";
import { queryClient } from "@/data/query-client";
import { removeResidentBrowserWebview } from "@/desktop/browser/resident-webviews";
import { useBrowserStore } from "@/desktop/browser/store";
import { getDesktopHost } from "@/desktop/host";
import { useArchiveAgent } from "@/hooks/use-archive-agent";
import { getPanelInstanceAttributes } from "@/panels/panel-instance-attributes";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import {
  buildTerminalsQueryKey,
  removeTerminalFromPayload,
} from "@/screens/workspace/terminals/state";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { collectAllTabs } from "@/stores/workspace-layout-actions";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { resolveCloseAgentTabPolicy } from "@/subagents";
import { getOrCreateClientId } from "@/utils/client-id";
import { confirmDialog } from "@/utils/confirm-dialog";
import { buildWorkspaceTabPersistenceKey, type WorkspaceTabTarget } from "@/workspace-tabs/model";

const EMPTY_SET = new Set<string>();

interface UseWorkspaceTabCloseInput {
  serverId: string;
  workspaceId: string;
  /** Runs once a tab is gone, for surface state keyed by it, such as a hovered close button. */
  onTabClosed: (tabId: string) => void;
}

export interface CloseWorkspaceTabWithCleanupInput {
  tabId: string;
  target?: WorkspaceTabTarget | null;
}

export interface WorkspaceTabClose {
  /** Closes one tab with every confirmation it needs: unsaved work, a terminal, a running agent. */
  closeTabById: (tabId: string) => Promise<void>;
  /** Runs a close at most once per tab at a time, and reports which tabs are closing. */
  runTabClose: (tabId: string, action: () => Promise<void>) => Promise<void>;
  /** Removes a tab from the layout along with what it holds open: a pinned agent, a browser. */
  closeWorkspaceTabWithCleanup: (input: CloseWorkspaceTabWithCleanupInput) => void;
  closingTabIds: Set<string>;
}

function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Closing a tab, for any surface that shows one: the workspace's tab strip, the compact tab
 * switcher and the sidebar's tab list. It reads the layout when a close starts rather than
 * subscribing, so a surface listing tabs of a workspace that is not on screen pays nothing for it.
 */
export function useWorkspaceTabClose({
  serverId,
  workspaceId,
  onTabClosed,
}: UseWorkspaceTabCloseInput): WorkspaceTabClose {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId);
  const workspaceDirectory = useWorkspaceDirectory(serverId, workspaceId);
  const { archiveAgent } = useArchiveAgent();
  const persistenceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  const pendingRef = useRef(new Set<string>());
  const [closingTabIds, setClosingTabIds] = useState<Set<string>>(EMPTY_SET);

  const runTabClose = useCallback(async (tabId: string, action: () => Promise<void>) => {
    const normalized = tabId.trim();
    if (!normalized || pendingRef.current.has(normalized)) {
      return;
    }
    pendingRef.current.add(normalized);
    setClosingTabIds(new Set(pendingRef.current));
    try {
      await action();
    } finally {
      pendingRef.current.delete(normalized);
      setClosingTabIds(new Set(pendingRef.current));
    }
  }, []);

  const closeWorkspaceTabWithCleanup = useCallback(
    function closeWorkspaceTabWithCleanup(input: CloseWorkspaceTabWithCleanupInput) {
      const normalizedTabId = trimNonEmpty(input.tabId);
      if (!normalizedTabId || !persistenceKey) {
        return;
      }
      const layoutStore = useWorkspaceLayoutStore.getState();
      if (input.target?.kind === "agent") {
        layoutStore.unpinAgent(persistenceKey, input.target.agentId);
        layoutStore.hideAgent(persistenceKey, input.target.agentId);
      }
      if (input.target?.kind === "browser") {
        const { browserId } = input.target;
        useBrowserStore.getState().removeBrowser(browserId);
        removeResidentBrowserWebview(browserId);
        void getDesktopHost()?.browser?.unregisterWorkspaceBrowser?.(browserId);
      }
      layoutStore.closeTab(persistenceKey, normalizedTabId);
    },
    [persistenceKey],
  );

  // A failed kill leaves the terminal running, so the list resyncs to bring it back.
  const killTerminalOrResync = useCallback(
    async (terminalId: string) => {
      const terminalsQueryKey = buildTerminalsQueryKey(
        serverId,
        workspaceDirectory,
        workspaceId || null,
      );
      const killed = client
        ? await client.killTerminal(terminalId).then(
            (payload) => payload.success,
            () => false,
          )
        : false;
      if (!killed) void queryClient.invalidateQueries({ queryKey: terminalsQueryKey });
    },
    [client, serverId, workspaceDirectory, workspaceId],
  );

  const closeTerminalTab = useCallback(
    async (input: { tabId: string; terminalId: string }) => {
      const { tabId, terminalId } = input;
      await runTabClose(tabId, async () => {
        const confirmed = await confirmDialog({
          title: t("workspace.tabs.confirmations.closeTerminalTitle"),
          message: t("workspace.tabs.confirmations.closeTerminalMessage"),
          confirmLabel: t("workspace.tabs.confirmations.close"),
          cancelLabel: t("workspace.tabs.confirmations.cancel"),
          destructive: true,
        });
        if (!confirmed) {
          return;
        }

        const terminalsQueryKey = buildTerminalsQueryKey(
          serverId,
          workspaceDirectory,
          workspaceId || null,
        );
        queryClient.setQueryData<ListTerminalsResponse["payload"]>(
          terminalsQueryKey,
          removeTerminalFromPayload(terminalId),
        );
        onTabClosed(tabId);
        closeWorkspaceTabWithCleanup({ tabId, target: { kind: "terminal", terminalId } });

        void killTerminalOrResync(terminalId);
      });
    },
    [
      closeWorkspaceTabWithCleanup,
      killTerminalOrResync,
      onTabClosed,
      runTabClose,
      serverId,
      t,
      workspaceDirectory,
      workspaceId,
    ],
  );

  const closeAgentTab = useCallback(
    async (input: { tabId: string; agentId: string }) => {
      const { tabId, agentId } = input;
      await runTabClose(tabId, async () => {
        if (!serverId) {
          return;
        }

        const agent = useSessionStore.getState().sessions[serverId]?.agents?.get(agentId) ?? null;
        let closePolicy = resolveCloseAgentTabPolicy(agent);
        const isRunning = agent?.status === "running";

        if (isRunning && closePolicy.kind === "archive-on-close") {
          const confirmed = await confirmDialog({
            title: t("workspace.tabs.confirmations.archiveRunningAgentTitle"),
            message: t("workspace.tabs.confirmations.archiveRunningAgentMessage"),
            confirmLabel: t("workspace.tabs.confirmations.archive"),
            cancelLabel: t("workspace.tabs.confirmations.cancel"),
            destructive: true,
          });
          if (!confirmed) {
            return;
          }
        }

        if (closePolicy.kind === "layout-only") {
          const sessionClient = useSessionStore.getState().sessions[serverId]?.client;
          if (!sessionClient) {
            toast.error(t("common.errors.daemonClientUnavailable"));
            return;
          }
          try {
            const clientId = await getOrCreateClientId();
            await sessionClient.updateAgent(agentId, {
              labels: { [getOpenAgentTabLabel(clientId)]: "false" },
            });
            const latestAgent =
              useSessionStore.getState().sessions[serverId]?.agents?.get(agentId) ?? null;
            closePolicy = resolveCloseAgentTabPolicy(latestAgent);
          } catch (error) {
            console.error("[WorkspaceTabClose] Failed to close subagent tab", { error, agentId });
            toast.error(t("workspace.tabs.toasts.failedToCloseAgent"));
            return;
          }
        }

        onTabClosed(tabId);
        closeWorkspaceTabWithCleanup({ tabId, target: { kind: "agent", agentId } });

        if (closePolicy.kind === "layout-only") {
          return;
        }

        // Errors (e.g. timeout) are handled by the mutation's onSettled callback
        void archiveAgent({ serverId, agentId }).catch(() => {});
      });
    },
    [archiveAgent, closeWorkspaceTabWithCleanup, onTabClosed, runTabClose, serverId, t, toast],
  );

  const confirmDiscardModifiedTab = useCallback(
    async (tabId: string): Promise<boolean> => {
      const attributes = getPanelInstanceAttributes({ serverId, workspaceId, tabId });
      if (!attributes.modified) return true;
      const resumePendingSave = attributes.suspendPendingSave?.();
      const confirmed = await confirmDialog({
        title: t("workspace.tabs.confirmations.unsavedTitle"),
        message: t("workspace.tabs.confirmations.unsavedMessage"),
        confirmLabel: t("workspace.tabs.confirmations.closeWithoutSaving"),
        cancelLabel: t("workspace.tabs.confirmations.cancel"),
        destructive: true,
      });
      if (!confirmed) resumePendingSave?.();
      return confirmed;
    },
    [serverId, workspaceId, t],
  );

  const closeTabById = useCallback(
    async (tabId: string) => {
      if (!persistenceKey) {
        return;
      }
      const layoutStore = useWorkspaceLayoutStore.getState();
      const sheets = layoutStore.sheetsByWorkspace[persistenceKey] ?? [];
      if (sheets.some((sheet) => sheet.tab.tabId === tabId)) {
        if (await confirmDiscardModifiedTab(tabId)) {
          useWorkspaceLayoutStore.getState().closeTab(persistenceKey, tabId);
        }
        return;
      }
      const layout = layoutStore.layoutByWorkspace[persistenceKey];
      const tab = layout
        ? collectAllTabs(layout.root).find((entry) => entry.tabId === tabId)
        : null;
      if (!tab) {
        return;
      }
      if (!(await confirmDiscardModifiedTab(tabId))) {
        return;
      }
      if (tab.target.kind === "terminal") {
        await closeTerminalTab({ tabId, terminalId: tab.target.terminalId });
        return;
      }
      if (tab.target.kind === "agent") {
        await closeAgentTab({ tabId, agentId: tab.target.agentId });
        return;
      }
      onTabClosed(tabId);
      closeWorkspaceTabWithCleanup({ tabId, target: tab.target });
    },
    [
      closeAgentTab,
      closeTerminalTab,
      closeWorkspaceTabWithCleanup,
      confirmDiscardModifiedTab,
      onTabClosed,
      persistenceKey,
    ],
  );

  return { closeTabById, runTabClose, closeWorkspaceTabWithCleanup, closingTabIds };
}
