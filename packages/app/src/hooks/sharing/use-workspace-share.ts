import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  desktopAuthCreateWorkspaceShare,
  desktopAuthListSharedWithMe,
  desktopAuthListWorkspaceShares,
  desktopAuthRevokeWorkspaceShare,
  desktopAuthUpdateWorkspaceShare,
  type DesktopCreateWorkspaceShareParams,
  type DesktopUpdateWorkspaceShareParams,
  type SharedWorkspaceRecord,
  type WorkspaceShareRecord,
} from "@/desktop/auth/desktop-auth";
import {
  webCreateWorkspaceShare,
  webListSharedWithMe,
  webListWorkspaceShares,
  webRevokeWorkspaceShare,
  webUpdateWorkspaceShare,
} from "@/desktop/auth/web-auth-api";
import { getIsElectron } from "@/constants/platform";

// Route workspace-share CRUD between the Electron bridge (desktop app) and
// the auth-server HTTP API (browsers + mobile). Desktop carries a bearer
// token via invokeDesktopCommand; web/mobile rely on the Better Auth cookie
// session so fetches include credentials.
const listShares = (orgId: string) =>
  getIsElectron() ? desktopAuthListWorkspaceShares(orgId) : webListWorkspaceShares(orgId);
const listSharedWithMe = (orgId: string) =>
  getIsElectron() ? desktopAuthListSharedWithMe(orgId) : webListSharedWithMe(orgId);
const createShare = (params: DesktopCreateWorkspaceShareParams) =>
  getIsElectron() ? desktopAuthCreateWorkspaceShare(params) : webCreateWorkspaceShare(params);
const updateShare = (params: DesktopUpdateWorkspaceShareParams) =>
  getIsElectron() ? desktopAuthUpdateWorkspaceShare(params) : webUpdateWorkspaceShare(params);
const revokeShare = (token: string) =>
  getIsElectron() ? desktopAuthRevokeWorkspaceShare(token) : webRevokeWorkspaceShare(token);

const EMPTY_SHARES: WorkspaceShareRecord[] = [];
const EMPTY_SHARED: SharedWorkspaceRecord[] = [];

function workspaceSharesQueryKey(orgId: string) {
  return ["workspaceShares", orgId] as const;
}

function sharedWorkspacesQueryKey(orgId: string) {
  return ["sharedWorkspaces", orgId] as const;
}

/**
 * Lists workspace shares owned by the current user in a given organization.
 */
export function useWorkspaceShares(orgId: string | null) {
  const query = useQuery<WorkspaceShareRecord[]>({
    queryKey: workspaceSharesQueryKey(orgId ?? ""),
    enabled: !!orgId,
    staleTime: 30_000,
    queryFn: () => listShares(orgId!),
  });

  return {
    shares: query.data ?? EMPTY_SHARES,
    isLoading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    refetch: query.refetch,
  };
}

/**
 * Lists workspace shares shared with the current user in a given organization.
 */
export function useSharedWorkspaces(orgId: string | null) {
  const query = useQuery<SharedWorkspaceRecord[]>({
    queryKey: sharedWorkspacesQueryKey(orgId ?? ""),
    enabled: !!orgId,
    staleTime: 30_000,
    queryFn: () => listSharedWithMe(orgId!),
  });

  return {
    shares: query.data ?? EMPTY_SHARED,
    isLoading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    refetch: query.refetch,
  };
}

/**
 * Mutations for creating, updating, and revoking workspace shares.
 */
export function useWorkspaceShareMutations(orgId: string | null) {
  const queryClient = useQueryClient();

  const invalidate = useCallback(() => {
    if (!orgId) return;
    void queryClient.invalidateQueries({ queryKey: workspaceSharesQueryKey(orgId) });
    void queryClient.invalidateQueries({ queryKey: sharedWorkspacesQueryKey(orgId) });
  }, [orgId, queryClient]);

  const createMutation = useMutation({
    mutationFn: (params: DesktopCreateWorkspaceShareParams) => createShare(params),
    onSuccess: invalidate,
  });

  const updateMutation = useMutation({
    mutationFn: (params: DesktopUpdateWorkspaceShareParams) => updateShare(params),
    onSuccess: invalidate,
  });

  const revokeMutation = useMutation({
    mutationFn: (token: string) => revokeShare(token),
    onSuccess: invalidate,
  });

  return {
    createShare: createMutation.mutateAsync,
    isCreating: createMutation.isPending,
    createError: createMutation.error instanceof Error ? createMutation.error.message : null,
    updateShare: updateMutation.mutateAsync,
    isUpdating: updateMutation.isPending,
    updateError: updateMutation.error instanceof Error ? updateMutation.error.message : null,
    revokeShare: revokeMutation.mutateAsync,
    isRevoking: revokeMutation.isPending,
    revokeError: revokeMutation.error instanceof Error ? revokeMutation.error.message : null,
  };
}
