import { useCallback } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import {
  desktopAuthGetSession,
  desktopAuthSignIn,
  desktopAuthSignOut,
  type DesktopAuthSession,
  type DesktopAuthUser,
} from "@/desktop/auth/desktop-auth";
import { webGetSession } from "@/desktop/auth/web-auth-api";
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
    mutationFn: (providerId: string | undefined) => desktopAuthSignIn(providerId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: AUTH_SESSION_QUERY_KEY });
    },
  });

  const signOutMutation = useMutation({
    mutationFn: () => desktopAuthSignOut(),
    onSuccess: () => {
      queryClient.setQueryData(AUTH_SESSION_QUERY_KEY, null);
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
