import { useCallback } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import {
  desktopAuthGetOrganizations,
  desktopAuthCreateOrganization,
  desktopAuthUpdateOrganization,
  type DesktopOrganization,
} from "@/desktop/auth/desktop-auth";
import {
  webCreateOrganization,
  webGetOrganizations,
  webUpdateOrganization,
} from "@/desktop/auth/web-auth-api";
import { getIsElectron } from "@/constants/platform";
import { useAuthSession } from "./use-auth-session";

const ORGANIZATIONS_QUERY_KEY = ["desktopOrganizations"] as const;

export function useOrganizations() {
  const queryClient = useQueryClient();
  const { isAuthenticated } = useAuthSession();
  const isElectron = getIsElectron();

  const query = useQuery<DesktopOrganization[]>({
    queryKey: ORGANIZATIONS_QUERY_KEY,
    enabled: isAuthenticated,
    staleTime: 60_000,
    queryFn: () => (isElectron ? desktopAuthGetOrganizations() : webGetOrganizations()),
  });

  const createMutation = useMutation({
    mutationFn: ({ name, slug, logo }: { name: string; slug: string; logo?: string }) =>
      isElectron
        ? desktopAuthCreateOrganization(name, slug, logo)
        : webCreateOrganization(name, slug, logo),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ORGANIZATIONS_QUERY_KEY });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({
      orgId,
      updates,
    }: {
      orgId: string;
      updates: { name?: string; slug?: string; logo?: string | null };
    }) =>
      isElectron
        ? desktopAuthUpdateOrganization(orgId, updates)
        : webUpdateOrganization(orgId, updates),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ORGANIZATIONS_QUERY_KEY });
    },
  });

  const refetch = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ORGANIZATIONS_QUERY_KEY });
  }, [queryClient]);

  return {
    organizations: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    createOrganization: createMutation.mutateAsync,
    isCreating: createMutation.isPending,
    createError: createMutation.error instanceof Error ? createMutation.error.message : null,
    updateOrganization: updateMutation.mutateAsync,
    isUpdating: updateMutation.isPending,
    updateError: updateMutation.error instanceof Error ? updateMutation.error.message : null,
    refetch,
  };
}
