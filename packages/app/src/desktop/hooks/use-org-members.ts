import { useCallback } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import {
  desktopAuthGetOrgMembers,
  desktopAuthInviteMember,
  desktopAuthRemoveMember,
  desktopAuthCancelInvitation,
  desktopAuthResendInvitation,
  type DesktopOrgMember,
  type DesktopInvitation,
} from "@/desktop/auth/desktop-auth";

function orgMembersQueryKey(orgId: string) {
  return ["desktopOrgMembers", orgId] as const;
}

export function useOrgMembers(orgId: string | null) {
  const queryClient = useQueryClient();

  const query = useQuery<{ members: DesktopOrgMember[]; invitations: DesktopInvitation[] }>({
    queryKey: orgMembersQueryKey(orgId ?? ""),
    enabled: !!orgId,
    staleTime: 60_000,
    queryFn: () => desktopAuthGetOrgMembers(orgId!),
  });

  const inviteMutation = useMutation({
    mutationFn: ({ email, role }: { email: string; role?: string }) =>
      desktopAuthInviteMember(orgId!, email, role),
    onSuccess: () => {
      if (orgId) {
        void queryClient.invalidateQueries({ queryKey: orgMembersQueryKey(orgId) });
      }
    },
  });

  const removeMutation = useMutation({
    mutationFn: (memberId: string) => desktopAuthRemoveMember(orgId!, memberId),
    onSuccess: () => {
      if (orgId) {
        void queryClient.invalidateQueries({ queryKey: orgMembersQueryKey(orgId) });
      }
    },
  });

  const cancelInvitationMutation = useMutation({
    mutationFn: (invitationId: string) => desktopAuthCancelInvitation(orgId!, invitationId),
    onSuccess: () => {
      if (orgId) {
        void queryClient.invalidateQueries({ queryKey: orgMembersQueryKey(orgId) });
      }
    },
  });

  const resendInvitationMutation = useMutation({
    mutationFn: (invitationId: string) => desktopAuthResendInvitation(orgId!, invitationId),
  });

  const refetch = useCallback(() => {
    if (orgId) {
      void queryClient.invalidateQueries({ queryKey: orgMembersQueryKey(orgId) });
    }
  }, [queryClient, orgId]);

  return {
    members: query.data?.members ?? [],
    invitations: query.data?.invitations ?? [],
    isLoading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    inviteMember: inviteMutation.mutateAsync,
    isInviting: inviteMutation.isPending,
    inviteError: inviteMutation.error instanceof Error ? inviteMutation.error.message : null,
    removeMember: removeMutation.mutateAsync,
    isRemoving: removeMutation.isPending,
    cancelInvitation: cancelInvitationMutation.mutateAsync,
    isCanceling: cancelInvitationMutation.isPending,
    resendInvitation: resendInvitationMutation.mutateAsync,
    isResending: resendInvitationMutation.isPending,
    refetch,
  };
}
