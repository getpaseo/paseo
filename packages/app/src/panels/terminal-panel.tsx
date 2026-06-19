import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Terminal } from "lucide-react-native";
import { Text, View } from "react-native";
import invariant from "tiny-invariant";
import type { ListTerminalsResponse } from "@getpaseo/protocol/messages";
import { deriveTerminalActivityStatusBucket } from "@getpaseo/protocol/terminal-activity";
import { TerminalPane } from "@/components/terminal-pane";
import { usePaneContext, usePaneFocus } from "@/panels/pane-context";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";
import { queryClient } from "@/query/query-client";
import { buildTerminalsQueryKey } from "@/screens/workspace/terminals/state";
import { usePanelStore } from "@/stores/panel-store";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceDirectory, useWorkspaceFields } from "@/stores/session-store-hooks";

type ListTerminalsPayload = ListTerminalsResponse["payload"];

const FLEX_FILL_STYLE = { flex: 1 } as const;
const CENTERED_PADDED_STYLE = {
  flex: 1,
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
} as const;

function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function useTerminalPanelDescriptor(
  target: { kind: "terminal"; terminalId: string },
  context: { serverId: string; workspaceId: string },
): PanelDescriptor {
  const { t } = useTranslation();
  const client = useSessionStore((state) => state.sessions[context.serverId]?.client ?? null);
  const workspaceDirectory = useWorkspaceDirectory(context.serverId, context.workspaceId);
  const terminalsQuery = useQuery(
    {
      queryKey: buildTerminalsQueryKey(
        context.serverId,
        workspaceDirectory,
        context.workspaceId || null,
      ),
      enabled: Boolean(client && workspaceDirectory),
      queryFn: async (): Promise<ListTerminalsPayload> => {
        if (!client || !workspaceDirectory) {
          throw new Error("Workspace directory not found");
        }
        return client.listTerminals(workspaceDirectory, undefined, {
          workspaceId: context.workspaceId || undefined,
        });
      },
      staleTime: 5_000,
    },
    queryClient,
  );
  const terminal =
    terminalsQuery.data?.terminals.find((entry) => entry.id === target.terminalId) ?? null;

  return {
    label:
      trimNonEmpty(terminal?.title ?? terminal?.name ?? null) ??
      t("workspace.tabs.fallback.terminal"),
    subtitle: t("workspace.tabs.fallback.terminal"),
    titleState: "ready",
    icon: Terminal,
    statusBucket: deriveTerminalActivityStatusBucket(terminal?.activity),
  };
}

function TerminalPanel() {
  const { serverId, workspaceId, target, openFileInWorkspace } = usePaneContext();
  const { isWorkspaceFocused, isPaneFocused } = usePaneFocus();
  const workspaceFields = useWorkspaceFields(serverId, workspaceId, (w) => ({
    workspaceDirectory: w.workspaceDirectory,
    isGitCheckout: w.projectKind === "git",
  }));
  const workspaceDirectory = workspaceFields?.workspaceDirectory || null;
  const isGitCheckout = workspaceFields?.isGitCheckout ?? false;
  const openFileExplorerForCheckout = usePanelStore((state) => state.openFileExplorerForCheckout);
  const handleOpenFileExplorer = useCallback(() => {
    if (!workspaceDirectory) {
      return;
    }
    openFileExplorerForCheckout({
      isCompact: true,
      checkout: { serverId, cwd: workspaceDirectory, isGit: isGitCheckout },
    });
  }, [isGitCheckout, openFileExplorerForCheckout, serverId, workspaceDirectory]);
  invariant(target.kind === "terminal", "TerminalPanel requires terminal target");

  if (!isWorkspaceFocused) {
    return <View style={FLEX_FILL_STYLE} />;
  }

  if (!workspaceDirectory) {
    return (
      <View style={CENTERED_PADDED_STYLE}>
        <Text>Workspace directory not found.</Text>
      </View>
    );
  }

  return (
    <TerminalPane
      serverId={serverId}
      cwd={workspaceDirectory}
      terminalId={target.terminalId}
      isWorkspaceFocused={isWorkspaceFocused}
      isPaneFocused={isPaneFocused}
      onOpenFileExplorer={handleOpenFileExplorer}
      onOpenWorkspaceFile={openFileInWorkspace}
    />
  );
}

export const terminalPanelRegistration: PanelRegistration<"terminal"> = {
  kind: "terminal",
  component: TerminalPanel,
  useDescriptor: useTerminalPanelDescriptor,
};
