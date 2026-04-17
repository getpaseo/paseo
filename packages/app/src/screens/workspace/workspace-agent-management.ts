import type { Agent } from "@/stores/session-store";
import { describeExternalSessionRecovery } from "@/utils/external-session";

export interface WorkspaceTabBadgeDescriptor {
  key: string;
  label: string;
  tone: "neutral" | "warning";
}

export interface WorkspaceTabAgentManagementState {
  badges: WorkspaceTabBadgeDescriptor[];
  reloadLabel: string;
  reloadTooltip: string;
}

const DEFAULT_RELOAD_LABEL = "Reload agent";
const DEFAULT_RELOAD_TOOLTIP = "Reload agent to update skills, MCPs or login status.";

type WorkspaceTabAgentShape = Pick<Agent, "status" | "archivedAt" | "persistence" | "runtimeInfo">;

export function deriveWorkspaceTabAgentManagementState(
  agent: WorkspaceTabAgentShape | null,
): WorkspaceTabAgentManagementState {
  if (!agent) {
    return {
      badges: [],
      reloadLabel: DEFAULT_RELOAD_LABEL,
      reloadTooltip: DEFAULT_RELOAD_TOOLTIP,
    };
  }

  const recoveryDescriptor = describeExternalSessionRecovery(agent);
  if (recoveryDescriptor.canRecoverWhenClosed) {
    return {
      badges: [{ key: "recoverable", label: "Recoverable", tone: "warning" }],
      reloadLabel: recoveryDescriptor.restartLabel,
      reloadTooltip: recoveryDescriptor.summary,
    };
  }

  return {
    badges: [],
    reloadLabel: DEFAULT_RELOAD_LABEL,
    reloadTooltip: DEFAULT_RELOAD_TOOLTIP,
  };
}
