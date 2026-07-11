import type { WorkspaceRecoveryState as AuthoritativeWorkspaceRecoveryState } from "@getpaseo/protocol/messages";

export type WorkspaceRecoveryModel =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "needsHostUpgrade" }
  | {
      kind: "recoverable";
      recovery: Extract<AuthoritativeWorkspaceRecoveryState, { kind: "recoverable" }>;
      phase: "ready" | "restoring" | "failed";
      error: string | null;
    }
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
  if (input.restore.pending && input.inspection.data?.kind === "recoverable") {
    return {
      kind: "recoverable",
      recovery: input.inspection.data,
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
  if (input.inspection.data?.kind === "recoverable") {
    return {
      kind: "recoverable",
      recovery: input.inspection.data,
      phase: resolveRecoveryPhase(input.restore),
      error: input.restore.error,
    };
  }
  return { kind: "checking" };
}
