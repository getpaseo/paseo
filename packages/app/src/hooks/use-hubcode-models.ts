// Fetches the "Hubcode" virtual provider — combos from OmniRoute, gated
// by the user's plan on auth-server. Used to inject a new entry into the
// model picker. Free users still see the entry but get an upgrade CTA on
// selection.

import { useQuery } from "@tanstack/react-query";
import { webGetHubcodeModels, type HubcodeModelsBundle } from "@/desktop/auth/web-auth-api";
import { useAuthSession } from "@/desktop/hooks/use-auth-session";

const QUERY_KEY = ["hubcodeModels"] as const;

export function useHubcodeModels(): {
  bundle: HubcodeModelsBundle | null;
  isLoading: boolean;
} {
  const { isAuthenticated, session } = useAuthSession();
  const sessionToken = session?.sessionToken ?? null;
  const query = useQuery<HubcodeModelsBundle | null>({
    queryKey: [...QUERY_KEY, sessionToken],
    enabled: isAuthenticated,
    staleTime: 60_000,
    queryFn: () => webGetHubcodeModels(sessionToken),
  });
  return { bundle: query.data ?? null, isLoading: query.isLoading };
}
