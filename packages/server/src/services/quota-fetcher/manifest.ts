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
    createForProfile: (options, profile) =>
      new ClaudeQuotaProvider({
        logger: options.logger,
        fetch: options.fetch,
        providerId: profile.providerId,
        displayName: profile.displayName,
        // A profile that leaves CLAUDE_CONFIG_DIR alone lands on the base provider's
        // directory, and the accountKey dedup drops it.
        claudeHome: profile.env?.["CLAUDE_CONFIG_DIR"]?.trim(),
      }),
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

export function createProviderUsageFetchers(
  options: ProviderUsageFetcherFactoryOptions,
): ProviderUsageFetcher[] {
  const profiles = options.profiles ?? [];
  const fetchers: ProviderUsageFetcher[] = [];
  const accounts = new Set<string>();

  function keep(fetcher: ProviderUsageFetcher): void {
    if (fetcher.accountKey) {
      if (accounts.has(fetcher.accountKey)) {
        return;
      }
      accounts.add(fetcher.accountKey);
    }
    fetchers.push(fetcher);
  }

  for (const entry of PROVIDER_USAGE_FETCHERS) {
    // The base provider claims its account first, so a profile that only relabels it
    // drops out rather than replacing the card the app has always shown.
    keep(entry.create(options));
    for (const profile of profiles) {
      if (profile.baseProviderId === entry.providerId && entry.createForProfile) {
        keep(entry.createForProfile(options, profile));
      }
    }
  }
  return fetchers;
}
