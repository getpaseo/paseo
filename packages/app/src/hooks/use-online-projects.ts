/**
 * React Query hook for the online project registry. Scoped to the active org —
 * switching orgs refetches. Used by the Team Projects picker and clone flow.
 */

import { useQuery } from "@tanstack/react-query";
import { listOnlineProjects, type ProjectRegistryEntry } from "@/api/project-registry";
import { useActiveOrgId } from "@/stores/active-org-store";
import { useAuthSession } from "@/desktop/hooks/use-auth-session";

const STALE_TIME_MS = 30_000;

export function useOnlineProjects(): {
  data: ProjectRegistryEntry[];
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<unknown>;
} {
  const activeOrgId = useActiveOrgId();
  const { session, isAuthenticated } = useAuthSession();
  const sessionToken = session?.sessionToken ?? "";

  const query = useQuery<ProjectRegistryEntry[]>({
    queryKey: ["onlineProjects", activeOrgId, sessionToken ? "bearer" : "cookie"],
    enabled: isAuthenticated && !!activeOrgId,
    staleTime: STALE_TIME_MS,
    queryFn: async () => {
      if (!activeOrgId) return [];
      return listOnlineProjects(activeOrgId, sessionToken || null);
    },
  });

  return {
    data: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    refetch: query.refetch,
  };
}
