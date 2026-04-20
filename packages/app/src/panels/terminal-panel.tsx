import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Terminal } from "lucide-react-native";
import { Text, View } from "react-native";
import invariant from "tiny-invariant";
import type { ListTerminalsResponse } from "@server/shared/messages";
import { TerminalPane } from "@/components/terminal-pane";
import { usePaneContext, usePaneFocus } from "@/panels/pane-context";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";
import { queryClient } from "@/query/query-client";
import { usePanelStore } from "@/stores/panel-store";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceExecutionAuthority } from "@/stores/session-store-hooks";

type ListTerminalsPayload = ListTerminalsResponse["payload"];

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
  const client = useSessionStore((state) => state.sessions[context.serverId]?.client ?? null);
  const workspaceAuthority = useWorkspaceExecutionAuthority(context.serverId, context.workspaceId)!;
  const workspaceDirectory = workspaceAuthority.ok
    ? workspaceAuthority.authority.workspaceDirectory
    : null;
  const terminalsQuery = useQuery(
    {
      queryKey: ["terminals", context.serverId, workspaceDirectory] as const,
      enabled: Boolean(client && workspaceDirectory),
      queryFn: async (): Promise<ListTerminalsPayload> => {
        if (!client || !workspaceDirectory) {
          throw new Error(
            workspaceAuthority.ok
              ? "Workspace execution directory not found"
              : workspaceAuthority.message,
          );
        }
        return client.listTerminals(workspaceDirectory);
      },
      staleTime: 5_000,
    },
    queryClient,
  );
  const terminal =
    terminalsQuery.data?.terminals.find((entry) => entry.id === target.terminalId) ?? null;

  return {
    label: trimNonEmpty(terminal?.title ?? terminal?.name ?? null) ?? "Terminal",
    subtitle: "Terminal",
    titleState: "ready",
    icon: Terminal,
    statusBucket: null,
  };
}

function TerminalPanel() {
  const { serverId, workspaceId, target } = usePaneContext();
  const { isWorkspaceFocused, isPaneFocused } = usePaneFocus();
  const workspaceAuthority = useWorkspaceExecutionAuthority(serverId, workspaceId)!;
  const workspaceDirectory = workspaceAuthority.ok
    ? workspaceAuthority.authority.workspaceDirectory
    : null;
  const isGitCheckout = workspaceAuthority.ok
    ? workspaceAuthority.authority.workspace.projectKind === "git"
    : false;
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
    return <View style={{ flex: 1 }} />;
  }

  if (!workspaceDirectory) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 16 }}>
        <Text>
          {workspaceAuthority.ok
            ? "Workspace execution directory not found."
            : workspaceAuthority.message}
        </Text>
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
    />
  );
}

export const terminalPanelRegistration: PanelRegistration<"terminal"> = {
  kind: "terminal",
  component: TerminalPanel,
  useDescriptor: useTerminalPanelDescriptor,
};
