import { useCallback } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import {
  desktopAuthGetOrganizations,
  desktopAuthCreateOrganization,
  type DesktopOrganization,
} from "@/desktop/auth/desktop-auth";
import { webGetOrganizations } from "@/desktop/auth/web-auth-api";
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
    mutationFn: ({ name, slug }: { name: string; slug: string }) =>
      desktopAuthCreateOrganization(name, slug),
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
    refetch,
  };
}
