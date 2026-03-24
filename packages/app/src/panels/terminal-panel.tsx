import { useQuery } from "@tanstack/react-query";
import { Terminal } from "lucide-react-native";
import { View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import invariant from "tiny-invariant";
import type { ListTerminalsResponse } from "@server/shared/messages";
import { TerminalPane } from "@/components/terminal-pane";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";
import { useSessionStore } from "@/stores/session-store";

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
  const terminalsQuery = useQuery({
    queryKey: ["terminals", context.serverId, context.workspaceId] as const,
    enabled: Boolean(client && context.workspaceId),
    queryFn: async (): Promise<ListTerminalsPayload> => {
      if (!client) {
        return { cwd: context.workspaceId, terminals: [], requestId: "missing-client" };
      }
      return client.listTerminals(context.workspaceId);
    },
    staleTime: 5_000,
  });
  const terminal =
    terminalsQuery.data?.terminals.find((entry) => entry.id === target.terminalId) ?? null;

  return {
    label: trimNonEmpty(terminal?.name ?? null) ?? "Terminal",
    subtitle: "Terminal",
    titleState: "ready",
    icon: Terminal,
    statusBucket: null,
  };
}

function TerminalPanel() {
  const isFocused = useIsFocused();
  const { serverId, workspaceId, target, isPaneFocused } = usePaneContext();
  invariant(target.kind === "terminal", "TerminalPanel requires terminal target");

  if (!isFocused) {
    return <View style={{ flex: 1 }} />;
  }

  return (
    <TerminalPane
      serverId={serverId}
      cwd={workspaceId}
      terminalId={target.terminalId}
      isPaneFocused={isPaneFocused}
    />
  );
}

export const terminalPanelRegistration: PanelRegistration<"terminal"> = {
  kind: "terminal",
  component: TerminalPanel,
  useDescriptor: useTerminalPanelDescriptor,
};
