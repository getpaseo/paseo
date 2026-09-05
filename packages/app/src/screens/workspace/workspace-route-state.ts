import type { HostRuntimeConnectionStatus } from "@/runtime/host-runtime";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import type { WorkspaceRecoveryModel } from "@/workspace-recovery/model";

export type WorkspaceRouteState =
  | { kind: "ready" }
  | {
      kind: "reconnecting";
      hostName: string;
      connectionStatus: Exclude<HostRuntimeConnectionStatus, "online">;
      lastError: string | null;
    }
  | {
      kind: "unreachable";
      hostName: string;
      connectionStatus: Exclude<HostRuntimeConnectionStatus, "online">;
      lastError: string | null;
    }
  | { kind: "loading"; hostName: string }
  | { kind: "missing"; hostName: string }
  | { kind: "needsHostUpgrade"; hostName: string }
  | {
      kind: "archived";
      hostName: string;
      recovery: Extract<WorkspaceRecoveryModel, { kind: "recoverable" }>;
    }
  | { kind: "recoveryUnavailable"; hostName: string; message: string }
  | { kind: "recoveryInspectionFailed"; hostName: string; error: string };

export function resolveWorkspaceRouteState(input: {
  hostName: string;
  connectionStatus: HostRuntimeConnectionStatus;
  lastError: string | null;
  workspace: WorkspaceDescriptor | null;
  hasHydratedWorkspaces: boolean;
  recovery: WorkspaceRecoveryModel;
}): WorkspaceRouteState {
  if (input.workspace) {
    if (input.connectionStatus === "online") {
      if (input.recovery.kind === "recoverable" && input.recovery.phase === "restoring") {
        return { kind: "archived", hostName: input.hostName, recovery: input.recovery };
      }
      return { kind: "ready" };
    }

    return {
      kind: "reconnecting",
      hostName: input.hostName,
      connectionStatus: input.connectionStatus,
      lastError: input.lastError,
    };
  }

  if (input.connectionStatus !== "online") {
    return {
      kind: "unreachable",
      hostName: input.hostName,
      connectionStatus: input.connectionStatus,
      lastError: input.lastError,
    };
  }

  if (!input.hasHydratedWorkspaces) {
    return { kind: "loading", hostName: input.hostName };
  }
  if (input.recovery.kind === "idle") {
    return { kind: "missing", hostName: input.hostName };
  }

  switch (input.recovery.kind) {
    case "checking":
      return { kind: "loading", hostName: input.hostName };
    case "needsHostUpgrade":
      return { kind: "needsHostUpgrade", hostName: input.hostName };
    case "recoverable":
      return { kind: "archived", hostName: input.hostName, recovery: input.recovery };
    case "unavailable":
      return {
        kind: "recoveryUnavailable",
        hostName: input.hostName,
        message: input.recovery.recovery.message,
      };
    case "unsupportedAction":
      return {
        kind: "recoveryUnavailable",
        hostName: input.hostName,
        message: "Update Paseo to recover this workspace.",
      };
    case "inspectionFailed":
      return {
        kind: "recoveryInspectionFailed",
        hostName: input.hostName,
        error: input.recovery.error,
      };
  }
}
