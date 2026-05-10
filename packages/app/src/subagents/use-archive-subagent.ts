import { useCallback } from "react";
import { useArchiveAgent } from "@/hooks/use-archive-agent";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { confirmDialog, type ConfirmDialogInput } from "@/utils/confirm-dialog";

export interface UseArchiveSubagentInput {
  serverId: string;
}

interface ResolveArchiveSubagentDialogInput {
  title: Agent["title"] | null | undefined;
  status: Agent["status"] | null | undefined;
}

function resolveSubagentLabel(title: Agent["title"] | null | undefined): string | null {
  if (typeof title !== "string") {
    return null;
  }
  const normalized = title.trim();
  if (!normalized) {
    return null;
  }
  if (normalized.toLowerCase() === "new agent") {
    return null;
  }
  return normalized;
}

export function resolveArchiveSubagentDialog(
  input: ResolveArchiveSubagentDialogInput,
): ConfirmDialogInput {
  const subagentLabel = resolveSubagentLabel(input.title) ?? "this subagent";
  const isRunning = input.status === "running" || input.status === "initializing";

  return {
    title: isRunning ? "Archive running subagent?" : "Archive subagent?",
    message: isRunning
      ? `${subagentLabel} is still running. Archiving it will stop the subagent and remove it from the track.`
      : `Remove ${subagentLabel} from the track. The subagent will be archived.`,
    confirmLabel: "Archive",
    cancelLabel: "Cancel",
    destructive: true,
  };
}

export function useArchiveSubagent(input: UseArchiveSubagentInput): (subagentId: string) => void {
  const { archiveAgent } = useArchiveAgent();
  const { serverId } = input;

  return useCallback(
    async (subagentId: string) => {
      const subagent = useSessionStore.getState().sessions[serverId]?.agents?.get(subagentId);
      const confirmed = await confirmDialog(
        resolveArchiveSubagentDialog({
          title: subagent?.title,
          status: subagent?.status,
        }),
      );
      if (!confirmed) {
        return;
      }
      void archiveAgent({ serverId, agentId: subagentId }).catch(() => {});
    },
    [archiveAgent, serverId],
  );
}
