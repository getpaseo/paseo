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
  /**
   * True when the Hubcode bundle is unavailable for an *auth* reason —
   * either no auth-server session at all, or the fetch returned a falsy
   * bundle (which webGetHubcodeModels does on any non-2xx, including
   * 401). Distinct from `isLoading` so the UI can render a "Sign in"
   * CTA instead of pretending the dropdown is still loading combos.
   */
  requiresSignIn: boolean;
} {
  const { isAuthenticated, isVerified, session } = useAuthSession();
  const sessionToken = session?.sessionToken ?? null;
  const query = useQuery<HubcodeModelsBundle | null>({
    queryKey: [...QUERY_KEY, sessionToken],
    // Same triple-gate as use-plan-limits — wait for the session
    // revalidation refetch to settle before trusting the cached
    // `sessionToken`, otherwise we burn a 401 against a token that
    // expired during the previous run.
    enabled: isVerified && isAuthenticated && !!sessionToken,
    staleTime: 60_000,
    // 401 is "session is stale" — `requiresSignIn` already handles that
    // path; retrying would just re-spam the console.
    retry: false,
    queryFn: () => webGetHubcodeModels(sessionToken),
  });
  const bundle = query.data ?? null;
  // requiresSignIn = "the user MUST sign in before this hook can do
  // anything useful". We hold off until:
  //   - the session refetch has settled (otherwise we'd flip the pill
  //     during the boot revalidation window), AND
  //   - if authenticated, the cached token has actually shown up, AND
  //   - if we did fetch, the response was null (stale cookie/token).
  // Anything else is treated as "still hydrating" — the UI should stay
  // quiet until the auth state settles.
  const isHydrating = !isVerified || (isAuthenticated && !sessionToken);
  const requiresSignIn =
    isVerified &&
    (!isAuthenticated ||
      (!isHydrating && !query.isLoading && !query.isFetching && bundle === null));
  return { bundle, isLoading: query.isLoading || isHydrating, requiresSignIn };
}
