import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createContext, createElement, type ReactNode, useContext, useMemo } from "react";

export interface SelectedWorkspaceGitAddress {
  readonly kind: "selected";
  workspaceId: string;
  cwd: string;
}

export interface LegacyWorkspaceGitAddress {
  readonly kind: "legacy";
  cwd: string;
}

export type WorkspaceGitQueryIdentity =
  | readonly [kind: "selected", workspaceId: string]
  | readonly [kind: "legacy", cwd: string];

export function workspaceGitQueryIdentitiesEqual(
  left: WorkspaceGitQueryIdentity,
  right: WorkspaceGitQueryIdentity,
): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

type WorkspaceGitBinder = Pick<DaemonClient, "bindWorkspaceGit">;
type LegacyWorkspaceGitBinder = Pick<
  DaemonClient,
  "checkoutPrStatus" | "getCheckoutStatus" | "searchForge" | "searchGitHub"
>;

export function bindSelectedWorkspaceGit(
  client: WorkspaceGitBinder,
  address: SelectedWorkspaceGitAddress,
) {
  const workspaceId = address.workspaceId.trim();
  if (workspaceId.length === 0) {
    throw new Error("workspaceId is required for selected workspace Git");
  }
  const cwd = address.cwd.trim();
  if (cwd.length === 0) {
    throw new Error("cwd is required for selected workspace Git");
  }
  return Object.assign(client.bindWorkspaceGit({ workspaceId, cwd }), {
    kind: "selected" as const,
    workspaceId,
    cwd,
    queryIdentity: ["selected", workspaceId] as const,
  });
}

export type WorkspaceGitClient = ReturnType<typeof bindSelectedWorkspaceGit>;
export type WorkspaceGitReadClient = Readonly<
  Pick<WorkspaceGitClient, "cwd" | "getPrStatus" | "getStatus" | "searchForge" | "searchGitHub"> & {
    queryIdentity: WorkspaceGitQueryIdentity;
  }
>;
export type WorkspaceGitTarget = Readonly<
  Pick<WorkspaceGitClient, "cwd" | "queryIdentity" | "workspaceId">
>;
export type WorkspaceGitStatusTarget = Readonly<
  Pick<WorkspaceGitReadClient, "cwd" | "queryIdentity">
>;

export function bindLegacyWorkspaceGit(
  client: LegacyWorkspaceGitBinder,
  address: LegacyWorkspaceGitAddress,
): WorkspaceGitReadClient & { readonly kind: "legacy" } {
  const cwd = address.cwd.trim();
  if (cwd.length === 0) {
    throw new Error("cwd is required for legacy workspace Git");
  }
  return {
    kind: "legacy",
    cwd,
    queryIdentity: ["legacy", cwd],
    getPrStatus: () => client.checkoutPrStatus(cwd),
    getStatus: () => client.getCheckoutStatus(cwd),
    searchForge: (options, requestId) => client.searchForge({ cwd, ...options }, requestId),
    searchGitHub: (options, requestId) => client.searchGitHub({ cwd, ...options }, requestId),
  };
}

export function PreWorkspaceComposerGitOwner({
  client,
  cwd,
  children,
}: {
  client: (WorkspaceGitBinder & LegacyWorkspaceGitBinder) | null;
  cwd: string | null;
  children?: ReactNode;
}) {
  const address = useMemo(() => (cwd === null ? null : ({ kind: "legacy", cwd } as const)), [cwd]);
  return createElement(WorkspaceGitOwner, { client, address }, children);
}

type LegacyWorkspaceGitClient = ReturnType<typeof bindLegacyWorkspaceGit>;
type WorkspaceGitCapability = WorkspaceGitClient | LegacyWorkspaceGitClient | null;
const MISSING_WORKSPACE_GIT_OWNER = Symbol("missing-workspace-git-owner");
const WorkspaceGitContext = createContext<
  WorkspaceGitCapability | typeof MISSING_WORKSPACE_GIT_OWNER
>(MISSING_WORKSPACE_GIT_OWNER);

export function useBoundWorkspaceGit(
  client: (WorkspaceGitBinder & LegacyWorkspaceGitBinder) | null,
  address: SelectedWorkspaceGitAddress | null,
): WorkspaceGitClient | null;
export function useBoundWorkspaceGit(
  client: (WorkspaceGitBinder & LegacyWorkspaceGitBinder) | null,
  address: LegacyWorkspaceGitAddress | null,
): LegacyWorkspaceGitClient | null;
export function useBoundWorkspaceGit(
  client: (WorkspaceGitBinder & LegacyWorkspaceGitBinder) | null,
  address: SelectedWorkspaceGitAddress | LegacyWorkspaceGitAddress | null,
): WorkspaceGitCapability;
export function useBoundWorkspaceGit(
  client: (WorkspaceGitBinder & LegacyWorkspaceGitBinder) | null,
  address: SelectedWorkspaceGitAddress | LegacyWorkspaceGitAddress | null,
): WorkspaceGitCapability {
  return useMemo(() => {
    if (!client || !address) return null;
    return address.kind === "selected"
      ? bindSelectedWorkspaceGit(client, address)
      : bindLegacyWorkspaceGit(client, address);
  }, [address, client]);
}

export function WorkspaceGitBoundary({
  workspaceGit,
  children,
}: {
  workspaceGit: WorkspaceGitCapability;
  children?: ReactNode;
}) {
  return createElement(WorkspaceGitContext.Provider, { value: workspaceGit }, children);
}

export function WorkspaceGitOwner({
  client,
  address,
  children,
}: {
  client: (WorkspaceGitBinder & LegacyWorkspaceGitBinder) | null;
  address: SelectedWorkspaceGitAddress | LegacyWorkspaceGitAddress | null;
  children?: ReactNode;
}) {
  const workspaceGit = useBoundWorkspaceGit(client, address);
  return createElement(WorkspaceGitBoundary, { workspaceGit }, children);
}

export function useWorkspaceGit(): WorkspaceGitReadClient | null {
  const workspaceGit = useContext(WorkspaceGitContext);
  if (workspaceGit === MISSING_WORKSPACE_GIT_OWNER) {
    throw new Error("Workspace Git owner is missing");
  }
  return workspaceGit;
}

export function useRequiredWorkspaceGit(): WorkspaceGitClient {
  const workspaceGit = useContext(WorkspaceGitContext);
  if (workspaceGit === MISSING_WORKSPACE_GIT_OWNER) {
    throw new Error("Workspace Git owner is missing");
  }
  if (!workspaceGit || workspaceGit.kind !== "selected") {
    throw new Error("Selected workspace Git is not bound");
  }
  return workspaceGit;
}
