import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Undo2 } from "lucide-react-native";
import type { AgentCapabilityFlags } from "@getpaseo/protocol/agent-types";
import type { CommandCenterContribution } from "@/command-center/contributions";
import { getCommandCenterIcon } from "@/command-center/icon";
import { useCommandCenterActions } from "@/command-center/provider";
import { hasActiveMessageSubmission } from "@/composer/submission/model";
import { useToast } from "@/contexts/toast-context";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useRewindAgentMutation } from "./use-rewind-agent-mutation";
import { useRewindMenuItems } from "./use-rewind-capabilities";

export function RewindCommandCenterRegistration({
  serverId,
  agentId,
  capabilities,
  enabled,
}: {
  serverId: string;
  agentId: string;
  capabilities: AgentCapabilityFlags | null | undefined;
  enabled: boolean;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const connected = useHostRuntimeIsConnected(serverId);
  const client = useSessionStore((state) => state.sessions[serverId]?.client);
  const message = useSessionStore((state) => {
    const session = state.sessions[serverId];
    if (
      !enabled ||
      !session ||
      hasActiveMessageSubmission(session.messageSubmissions.get(agentId))
    ) {
      return undefined;
    }
    return (
      session.agentStreamHead.get(agentId)?.findLast((item) => item.kind === "user_message") ??
      session.agentStreamTail.get(agentId)?.findLast((item) => item.kind === "user_message")
    );
  });
  const { rewindAgent, isPending } = useRewindAgentMutation({
    serverId,
    agentId,
    client,
    messageId: message?.messageId,
  });
  const items = useRewindMenuItems(capabilities);
  const actions = useMemo<CommandCenterContribution[]>(() => {
    if (!message?.messageId) return [];
    return items.map((item, rank) => ({
      id: `rewind:${item.mode}`,
      group: "rewind",
      groupRank: 1.5,
      rank,
      visibility: "query",
      keywords: ["rewind last turn", ...(item.mode === "files" ? [] : ["rewind chat"])],
      presentation: {
        kind: "action",
        title: item.label,
        subtitle: t("rewind.warning"),
        icon: getCommandCenterIcon(Undo2),
      },
      run: async () => {
        const dismiss = toast.show(`${item.label}…`, { durationMs: null });
        try {
          await rewindAgent({ mode: item.mode, rewoundText: message.text });
        } catch {
          // The mutation reports the failure through the app toast.
        } finally {
          dismiss();
        }
      },
    }));
  }, [items, message, rewindAgent, t, toast]);

  useCommandCenterActions({
    sourceId: `rewind:${serverId}:${agentId}`,
    enabled: enabled && connected && Boolean(client) && !isPending,
    actions,
  });
  return null;
}
