import type { Logger } from "pino";
import { z } from "zod";
import type { ProviderApiFetch, ProviderUsageFetcher } from "./provider.js";
import { ClaudeQuotaProvider } from "./providers/claude.js";

const CLAUDE_OAUTH_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";

// The slice of a provider override this module reads. Validated per entry
// because provider config schemas are passthrough records: the fields exist at
// runtime but not in their inferred types, and one malformed entry must not
// take down the other profiles' usage.
const ProfileProviderConfigSchema = z
  .object({
    extends: z.string().optional(),
    label: z.string().optional(),
    enabled: z.boolean().optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .loose();

export interface BuildProfileUsageFetchersOptions {
  providers: Record<string, unknown> | undefined;
  logger: Logger;
  fetch?: ProviderApiFetch;
}

/**
 * Usage fetchers for provider profiles that pin their own account.
 *
 * A profile extending `claude` with a CLAUDE_CODE_OAUTH_TOKEN bills to that
 * token's account, so its usage must be fetched with that token — the shared
 * credential stores describe whichever account the CLI is currently on. Each
 * qualifying profile becomes its own usage entry, keyed by the profile id the
 * app already uses as the agent's provider id, so the context-meter tooltip
 * and the host Usage page match it exactly.
 *
 * Profiles without a pinned token are skipped rather than duplicated: their
 * agents run on the shared login, which the base `claude` entry already
 * describes. Other base providers have account-bound usage endpoints of their
 * own and are not derivable from an env token, so only Claude profiles are
 * covered here.
 */
export function buildProfileUsageFetchers(
  options: BuildProfileUsageFetchersOptions,
): ProviderUsageFetcher[] {
  return createProfileUsageFetcherSource({
    ...options,
    getProviders: () => options.providers,
  })();
}

export interface ProfileUsageFetcherSourceOptions {
  getProviders: () => Record<string, unknown> | undefined;
  logger: Logger;
  fetch?: ProviderApiFetch;
}

/**
 * A `dynamicFetchers` source that keeps fetcher instances across refreshes.
 *
 * The source re-reads the live config on every call so `paseo daemon reload`
 * applies profile changes, but a qualifying profile keeps its fetcher instance
 * for as long as its identity (id, token, label) is unchanged. The instance
 * carries state worth keeping: the resolved ping model, and whether the usage
 * endpoint already refused the token's scope — rebuilding it every refresh
 * would re-knock on a permanently closed door each time. A changed token or
 * label makes a fresh instance; profiles gone from the config drop theirs.
 */
export function createProfileUsageFetcherSource(
  options: ProfileUsageFetcherSourceOptions,
): () => ProviderUsageFetcher[] {
  const instances = new Map<string, ClaudeQuotaProvider>();
  return () => {
    const fetchers: ProviderUsageFetcher[] = [];
    const seen = new Set<string>();
    for (const [providerId, entry] of Object.entries(options.getProviders() ?? {})) {
      const parsed = ProfileProviderConfigSchema.safeParse(entry);
      if (!parsed.success) continue;
      const override = parsed.data;
      if (override.enabled === false) continue;
      if (override.extends !== "claude") continue;
      const token = override.env?.[CLAUDE_OAUTH_TOKEN_ENV]?.trim();
      if (!token) continue;
      const displayName = override.label ?? providerId;
      const key = `${providerId}\u0000${token}\u0000${displayName}`;
      seen.add(key);
      let fetcher = instances.get(key);
      if (!fetcher) {
        fetcher = new ClaudeQuotaProvider({
          logger: options.logger,
          fetch: options.fetch,
          providerId,
          displayName,
          accessToken: token,
        });
        instances.set(key, fetcher);
      }
      fetchers.push(fetcher);
    }
    for (const key of instances.keys()) {
      if (!seen.has(key)) instances.delete(key);
    }
    return fetchers;
  };
}
