import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
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
import { unavailableUsage } from "./usage.js";

export const PROVIDER_USAGE_FETCHERS: readonly ProviderUsageFetcherManifestEntry[] = [
  {
    providerId: "claude",
    create: (options) =>
      new ClaudeQuotaProvider({
        logger: options.logger,
        fetch: options.fetch,
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
  providers: MutableDaemonConfig["providers"] = {},
): ProviderUsageFetcher[] {
  const fetchers: ProviderUsageFetcher[] = [];
  for (const entry of PROVIDER_USAGE_FETCHERS) {
    fetchers.push(entry.create(options));
    for (const [providerId, providerConfig] of Object.entries(providers)) {
      if (providerConfig.extends === entry.providerId) {
        fetchers.push(createProviderAccountUsageFetcher(options, providerId, providerConfig));
      }
    }
  }
  return fetchers;
}

function providerEnvironment(providerConfig: Record<string, unknown>): NodeJS.ProcessEnv {
  const env = providerConfig.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) return {};
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function createProviderAccountUsageFetcher(
  options: ProviderUsageFetcherFactoryOptions,
  providerId: string,
  providerConfig: MutableDaemonConfig["providers"][string],
): ProviderUsageFetcher {
  const baseProviderId = String(providerConfig.extends);
  const displayName =
    typeof providerConfig.label === "string" && providerConfig.label.trim()
      ? providerConfig.label.trim()
      : providerId;
  const env = providerEnvironment(providerConfig);
  let baseFetcher: ProviderUsageFetcher | null = null;

  if (baseProviderId === "claude") {
    const claudeHome = env["CLAUDE_CONFIG_DIR"] || env["CLAUDE_HOME"];
    if (claudeHome) {
      baseFetcher = new ClaudeQuotaProvider({
        logger: options.logger,
        fetch: options.fetch,
        claudeHome,
        claudeKeychainReader: async () => null,
      });
    }
  } else if (baseProviderId === "codex") {
    const codexHome = env["CODEX_HOME"];
    if (codexHome) {
      baseFetcher = new CodexQuotaProvider({
        logger: options.logger,
        fetch: options.fetch,
        codexHome,
        includeDefaultAuthPaths: false,
      });
    }
  } else if (baseProviderId === "copilot") {
    baseFetcher = new CopilotQuotaProvider({
      logger: options.logger,
      fetch: options.fetch,
      env,
      readCliToken: async () => null,
    });
  }

  return {
    providerId,
    baseProviderId,
    displayName,
    fetchUsage: async () => {
      if (!baseFetcher) {
        return unavailableUsage({ providerId, baseProviderId, displayName });
      }
      const usage = await baseFetcher.fetchUsage();
      return { ...usage, providerId, baseProviderId, displayName };
    },
  };
}
