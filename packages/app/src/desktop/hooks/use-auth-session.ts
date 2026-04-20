import { useCallback } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import {
  desktopAuthGetSession,
  desktopAuthSignIn,
  desktopAuthSignOut,
  type DesktopAuthSession,
  type DesktopAuthUser,
} from "@/desktop/auth/desktop-auth";
import { webGetSession, webSignIn, webSignOut } from "@/desktop/auth/web-auth-api";
import { getIsElectron } from "@/constants/platform";

const AUTH_SESSION_QUERY_KEY = ["desktopAuthSession"] as const;

export function useAuthSession() {
  const queryClient = useQueryClient();
  const isElectron = getIsElectron();

  const query = useQuery<DesktopAuthSession | null>({
    queryKey: AUTH_SESSION_QUERY_KEY,
    staleTime: 60_000,
    refetchOnMount: "always",
    queryFn: () => (isElectron ? desktopAuthGetSession() : webGetSession()),
  });

  const signInMutation = useMutation({
    mutationFn: async (providerId: string | undefined) => {
      if (isElectron) {
        return desktopAuthSignIn(providerId);
      }
      // Web: full-page redirect to auth-server. Never resolves — the browser
      // navigates away. Return a never-resolving promise so the mutation stays
      // in pending state until the navigation completes.
      webSignIn();
      return new Promise<never>(() => {});
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: AUTH_SESSION_QUERY_KEY });
    },
  });

  const signOutMutation = useMutation({
    mutationFn: () => (isElectron ? desktopAuthSignOut() : webSignOut()),
    onSuccess: () => {
      queryClient.setQueryData(AUTH_SESSION_QUERY_KEY, null);
      // Wipe every auth-scoped cache so the UI doesn't keep showing the
      // signed-in user's orgs, members, or shared workspaces. The org rail
      // subscribes to `["desktopOrganizations"]` and the shared workspaces
      // sidebar keys off workspace-share queries — both go stale on sign-out.
      queryClient.setQueryData(["desktopOrganizations"], []);
      void queryClient.invalidateQueries({ queryKey: ["desktopOrganizations"] });
      void queryClient.invalidateQueries({ queryKey: ["workspaceShares"] });
      void queryClient.invalidateQueries({ queryKey: ["sharedWorkspaces"] });
      void queryClient.invalidateQueries({ queryKey: ["desktopOrgMembers"] });
      // Clear the active-org selection so downstream selectors don't keep
      // pointing at an org the user is no longer authenticated for.
      void import("@/stores/active-org-store").then(({ setActiveOrgId }) => {
        setActiveOrgId(null);
      });
    },
  });

  const refetch = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: AUTH_SESSION_QUERY_KEY });
  }, [queryClient]);

  const session = query.data ?? null;

  return {
    session,
    user: session?.user ?? null,
    isAuthenticated: session !== null,
    isLoading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    signIn: signInMutation.mutateAsync,
    signOut: signOutMutation.mutateAsync,
    isSigningIn: signInMutation.isPending,
    isSigningOut: signOutMutation.isPending,
    signInError: signInMutation.error instanceof Error ? signInMutation.error.message : null,
    refetch,
  };
}

export function useAuthUser(): DesktopAuthUser | null {
  const { user } = useAuthSession();
  return user;
}
