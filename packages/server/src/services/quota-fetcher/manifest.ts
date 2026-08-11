import { isAbsolute } from "node:path";
import type { Logger } from "pino";
import type {
  ProviderUsageFetcher,
  ProviderUsageFetcherFactoryOptions,
  ProviderUsageFetcherManifestEntry,
} from "./provider.js";
import { ClaudeQuotaProvider } from "./providers/claude.js";
import { CodexQuotaProvider } from "./providers/codex.js";
import { CopilotQuotaProvider } from "./providers/copilot.js";
import { CursorQuotaProvider } from "./providers/cursor.js";
import { GrokQuotaProvider } from "./providers/grok.js";
import { KimiQuotaProvider } from "./providers/kimi.js";
import { MiniMaxQuotaProvider } from "./providers/minimax.js";
import { ZaiQuotaProvider } from "./providers/zai.js";

export const PROVIDER_USAGE_FETCHERS: readonly ProviderUsageFetcherManifestEntry[] = [
  {
    providerId: "claude",
    create: (options) =>
      new ClaudeQuotaProvider({
        logger: options.logger,
        fetch: options.fetch,
      }),
    createForProfile: (options, profile) => {
      // A profile that leaves CLAUDE_CONFIG_DIR alone lands on the base provider's
      // directory, and the account-key dedup drops it.
      const configDir = profile.env?.["CLAUDE_CONFIG_DIR"]?.trim();
      if (configDir && !isAbsolute(configDir)) {
        // Claude Code resolves a relative CLAUDE_CONFIG_DIR against the project the agent
        // runs in; the daemon has no such project, so any directory we picked would be a
        // guess at whose credentials to read.
        options.logger.debug(
          { providerId: profile.providerId, configDir },
          "Skipping usage card for provider profile with a relative CLAUDE_CONFIG_DIR",
        );
        return null;
      }
      return new ClaudeQuotaProvider({
        logger: options.logger,
        fetch: options.fetch,
        providerId: profile.providerId,
        displayName: profile.displayName,
        claudeHome: configDir,
      });
    },
  },
  {
    providerId: "codex",
    create: (options) =>
      new CodexQuotaProvider({
        logger: options.logger,
        fetch: options.fetch,
      }),
  },
  {
    providerId: "copilot",
    create: (options) => new CopilotQuotaProvider({ logger: options.logger, fetch: options.fetch }),
  },
  {
    providerId: "cursor",
    create: (options) => new CursorQuotaProvider({ logger: options.logger, fetch: options.fetch }),
  },
  {
    providerId: "zai",
    create: (options) => new ZaiQuotaProvider({ logger: options.logger, fetch: options.fetch }),
  },
  {
    providerId: "grok",
    create: (options) => new GrokQuotaProvider({ logger: options.logger, fetch: options.fetch }),
  },
  {
    providerId: "kimi",
    create: (options) => new KimiQuotaProvider({ logger: options.logger, fetch: options.fetch }),
  },
  {
    providerId: "minimax",
    create: (options) => new MiniMaxQuotaProvider({ logger: options.logger, fetch: options.fetch }),
  },
];

/**
 * Drops every fetcher that reports on an account an earlier one already covers.
 *
 * Runs before any usage is fetched: two fetchers on one account would refresh the same
 * OAuth token, and the rotated token from one write invalidates the other.
 *
 * Resolving a key touches credentials, so it can fail on its own. A fetcher that cannot
 * name its account keeps its card and is never deduplicated — the same way a provider
 * that never had a key is treated — rather than costing every other provider its card.
 */
export async function dedupeProviderUsageFetchers(
  candidates: readonly ProviderUsageFetcher[],
  logger?: Logger,
): Promise<ProviderUsageFetcher[]> {
  const keys = await Promise.allSettled(
    candidates.map((candidate) => candidate.resolveAccountKey?.() ?? undefined),
  );
  const fetchers: ProviderUsageFetcher[] = [];
  const accounts = new Set<string>();

  for (const [index, candidate] of candidates.entries()) {
    const key = keys[index];
    if (key?.status === "rejected") {
      logger?.debug(
        { err: key.reason, providerId: candidate.providerId },
        "Provider usage account resolution failed; card is kept and not deduplicated",
      );
    }
    const accountKey = key?.status === "fulfilled" ? key.value : undefined;
    if (accountKey) {
      if (accounts.has(accountKey)) {
        continue;
      }
      accounts.add(accountKey);
    }
    fetchers.push(candidate);
  }
  return fetchers;
}

export async function createProviderUsageFetchers(
  options: ProviderUsageFetcherFactoryOptions,
): Promise<ProviderUsageFetcher[]> {
  const profiles = options.profiles ?? [];
  const candidates: ProviderUsageFetcher[] = [];

  for (const entry of PROVIDER_USAGE_FETCHERS) {
    // The base provider claims its account first, so a profile that only relabels it
    // drops out rather than replacing the card the app has always shown.
    candidates.push(entry.create(options));
    for (const profile of profiles) {
      if (profile.baseProviderId !== entry.providerId || !entry.createForProfile) {
        continue;
      }
      const fetcher = entry.createForProfile(options, profile);
      if (fetcher) {
        candidates.push(fetcher);
      }
    }
  }
  return dedupeProviderUsageFetchers(candidates, options.logger);
}
