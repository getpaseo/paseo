import type { WorkspaceRecoveryState as AuthoritativeWorkspaceRecoveryState } from "@getpaseo/protocol/messages";

type AuthoritativeRecoverableWorkspace = Extract<
  AuthoritativeWorkspaceRecoveryState,
  { kind: "recoverable" }
>;

export type SupportedWorkspaceRecoveryAction = "unarchive" | "restore";

type SupportedRecoverableWorkspace = Omit<AuthoritativeRecoverableWorkspace, "action"> & {
  action: SupportedWorkspaceRecoveryAction;
};

export type WorkspaceRecoveryModel =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "needsHostUpgrade" }
  | {
      kind: "recoverable";
      recovery: SupportedRecoverableWorkspace;
      phase: "ready" | "restoring" | "failed";
      error: string | null;
    }
  | { kind: "unsupportedAction"; action: string }
  | {
      kind: "unavailable";
      recovery: Extract<AuthoritativeWorkspaceRecoveryState, { kind: "unavailable" }>;
    }
  | { kind: "inspectionFailed"; error: string };

export interface WorkspaceRecoveryController {
  state: WorkspaceRecoveryModel;
  restore: () => void;
  retryInspection: () => void;
}

export interface WorkspaceSelectionRecoveryClient {
  restoreWorkspace: (workspaceId: string) => Promise<unknown>;
  refreshAgent: (agentId: string) => Promise<unknown>;
}

export async function recoverWorkspaceSelection(input: {
  client: WorkspaceSelectionRecoveryClient;
  workspaceId: string;
  agentId?: string | null;
}): Promise<void> {
  await input.client.restoreWorkspace(input.workspaceId);
  if (input.agentId) {
    await input.client.refreshAgent(input.agentId);
  }
}

function resolveRecoveryPhase(input: {
  pending: boolean;
  error: string | null;
}): "ready" | "restoring" | "failed" {
  if (input.pending) {
    return "restoring";
  }
  if (input.error) {
    return "failed";
  }
  return "ready";
}

function getSupportedRecovery(
  recovery: AuthoritativeWorkspaceRecoveryState | undefined,
): SupportedRecoverableWorkspace | null {
  if (recovery?.kind !== "recoverable") {
    return null;
  }
  if (recovery.action !== "restore" && recovery.action !== "unarchive") {
    return null;
  }
  return { ...recovery, action: recovery.action };
}

export function resolveWorkspaceRecoveryModel(input: {
  enabled: boolean;
  connected: boolean;
  hasClient: boolean;
  hasServerInfo: boolean;
  supportsRecovery: boolean;
  inspection: {
    pending: boolean;
    error: string | null;
    data: AuthoritativeWorkspaceRecoveryState | undefined;
  };
  restore: { pending: boolean; error: string | null };
}): WorkspaceRecoveryModel {
  const supportedRecovery = getSupportedRecovery(input.inspection.data);
  if (input.restore.pending && supportedRecovery) {
    return {
      kind: "recoverable",
      recovery: supportedRecovery,
      phase: "restoring",
      error: null,
    };
  }
  if (!input.enabled || !input.connected || !input.hasClient) {
    return { kind: "idle" };
  }
  if (!input.hasServerInfo) {
    return { kind: "checking" };
  }
  if (!input.supportsRecovery) {
    return { kind: "needsHostUpgrade" };
  }
  if (input.inspection.pending) {
    return { kind: "checking" };
  }
  if (input.inspection.error) {
    return { kind: "inspectionFailed", error: input.inspection.error };
  }
  if (input.inspection.data?.kind === "unavailable") {
    return { kind: "unavailable", recovery: input.inspection.data };
  }
  if (input.inspection.data?.kind === "recoverable" && !supportedRecovery) {
    return { kind: "unsupportedAction", action: input.inspection.data.action };
  }
  if (supportedRecovery) {
    return {
      kind: "recoverable",
      recovery: supportedRecovery,
      phase: resolveRecoveryPhase(input.restore),
      error: input.restore.error,
    };
  }
  return { kind: "checking" };
}
