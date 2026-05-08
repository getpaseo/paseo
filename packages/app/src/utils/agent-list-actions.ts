import type { AggregatedAgent } from "@/types/aggregated-agent";
import { describeExternalSessionRecovery } from "@/utils/external-session";

export interface AgentActionSheetState {
  title: string;
  summary: string | null;
  isRecoverableExternalSession: boolean;
  recoverLabel: string | null;
  canRecover: boolean;
  canArchive: boolean;
}

export function deriveAgentActionSheetState(
  agent: AggregatedAgent,
  isDaemonUnavailable: boolean,
): AgentActionSheetState {
  const descriptor = describeExternalSessionRecovery(agent);
  const canArchive = !agent.archivedAt && !isDaemonUnavailable;

  if (isDaemonUnavailable) {
    return {
      title: "Host offline",
      summary: "Reconnect to this host before reopening or archiving the session.",
      isRecoverableExternalSession: descriptor.canRecoverWhenClosed,
      recoverLabel: descriptor.canRecoverWhenClosed ? descriptor.restartLabel : null,
      canRecover: false,
      canArchive: false,
    };
  }

  if (descriptor.canRecoverWhenClosed) {
    return {
      title: "Recover this session?",
      summary: descriptor.summary,
      isRecoverableExternalSession: true,
      recoverLabel: descriptor.restartLabel,
      canRecover: true,
      canArchive,
    };
  }

  return {
    title: agent.archivedAt ? "Session actions" : "Archive this session?",
    summary: agent.archivedAt
      ? "This session is already archived."
      : "Archived sessions remain visible but move out of the active flow.",
    isRecoverableExternalSession: false,
    recoverLabel: null,
    canRecover: false,
    canArchive,
  };
}
