import { describe, expect, it } from "vitest";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import type { WorkspaceRecoveryModel } from "@/workspace-recovery/model";
import { resolveWorkspaceRouteState } from "./workspace-route-state";

function createWorkspaceDescriptor(): WorkspaceDescriptor {
  return {
    id: "workspace-1",
    projectId: "project-1",
    projectDisplayName: "Project",
    projectRootPath: "/repo/project",
    workspaceDirectory: "/repo/project",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: "main",
    status: "running",
    diffStat: null,
    scripts: [],
    archivingAt: null,
    statusEnteredAt: null,
  };
}

function resolve(input: {
  workspace?: WorkspaceDescriptor | null;
  connectionStatus?: "online" | "offline";
  hasHydratedWorkspaces?: boolean;
  recovery?: WorkspaceRecoveryModel;
}) {
  return resolveWorkspaceRouteState({
    hostName: "Laptop",
    connectionStatus: input.connectionStatus ?? "online",
    lastError: input.connectionStatus === "offline" ? "transport closed" : null,
    workspace: input.workspace ?? null,
    hasHydratedWorkspaces: input.hasHydratedWorkspaces ?? true,
    recovery: input.recovery ?? { kind: "checking" },
  });
}

const recoverable = {
  kind: "recoverable",
  recovery: {
    kind: "recoverable",
    workspaceId: "workspace-1",
    workspaceName: "Feature branch",
    action: "restore",
    branch: "feature",
  },
  phase: "ready",
  error: null,
} as const satisfies WorkspaceRecoveryModel;

describe("resolveWorkspaceRouteState", () => {
  it("keeps a missing route unreachable while its host is offline", () => {
    expect(resolve({ connectionStatus: "offline" })).toEqual({
      kind: "unreachable",
      hostName: "Laptop",
      connectionStatus: "offline",
      lastError: "transport closed",
    });
  });

  it("keeps a cached workspace visible while its host reconnects", () => {
    expect(
      resolve({ workspace: createWorkspaceDescriptor(), connectionStatus: "offline" }),
    ).toEqual({
      kind: "reconnecting",
      hostName: "Laptop",
      connectionStatus: "offline",
      lastError: "transport closed",
    });
  });

  it("waits for workspace hydration and authoritative recovery inspection", () => {
    expect(resolve({ hasHydratedWorkspaces: false })).toEqual({
      kind: "loading",
      hostName: "Laptop",
    });
    expect(resolve({ recovery: { kind: "checking" } })).toEqual({
      kind: "loading",
      hostName: "Laptop",
    });
  });

  it("keeps an ordinary missing route distinct from an explicit recovery request", () => {
    expect(resolve({ recovery: { kind: "idle" } })).toEqual({
      kind: "missing",
      hostName: "Laptop",
    });
    expect(resolve({ recovery: { kind: "needsHostUpgrade" } })).toEqual({
      kind: "needsHostUpgrade",
      hostName: "Laptop",
    });
  });

  it("renders the authoritative archived-workspace state through ready, restoring, and failed phases", () => {
    expect(resolve({ recovery: recoverable })).toEqual({
      kind: "archived",
      hostName: "Laptop",
      recovery: recoverable,
    });

    const restoring = { ...recoverable, phase: "restoring" as const };
    expect(resolve({ recovery: restoring })).toMatchObject({
      kind: "archived",
      recovery: { phase: "restoring" },
    });

    const failed = {
      ...recoverable,
      phase: "failed" as const,
      error: "Project root is missing",
    };
    expect(resolve({ recovery: failed })).toMatchObject({
      kind: "archived",
      recovery: { phase: "failed", error: "Project root is missing" },
    });
  });

  it("distinguishes unsupported and authoritatively unavailable workspaces", () => {
    expect(resolve({ recovery: { kind: "needsHostUpgrade" } })).toEqual({
      kind: "needsHostUpgrade",
      hostName: "Laptop",
    });
    expect(
      resolve({
        recovery: {
          kind: "unavailable",
          recovery: {
            kind: "unavailable",
            workspaceId: "workspace-1",
            reason: "workspace_directory_missing",
            message: "The workspace directory cannot be recreated.",
          },
        },
      }),
    ).toEqual({
      kind: "recoveryUnavailable",
      hostName: "Laptop",
      message: "The workspace directory cannot be recreated.",
    });

    expect(
      resolve({
        recovery: {
          kind: "unsupportedAction",
          action: "repair_from_snapshot",
        },
      }),
    ).toEqual({
      kind: "recoveryUnavailable",
      hostName: "Laptop",
      message: "Update Paseo to recover this workspace.",
    });
  });

  it("keeps loading visible when the descriptor arrives, then uses it as the success transition", () => {
    const restoring = { ...recoverable, phase: "restoring" as const };
    expect(
      resolve({
        workspace: createWorkspaceDescriptor(),
        recovery: restoring,
      }),
    ).toEqual({ kind: "archived", hostName: "Laptop", recovery: restoring });

    expect(
      resolve({
        workspace: createWorkspaceDescriptor(),
        recovery: recoverable,
      }),
    ).toEqual({ kind: "ready" });
  });
});
