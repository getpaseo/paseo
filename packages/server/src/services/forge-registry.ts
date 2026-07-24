import type pino from "pino";
import { getForgeDefinition } from "@getpaseo/protocol/forge-manifest";
import { normalizeHost } from "@getpaseo/protocol/git-remote";
import { resolveForgeCliPath } from "./forge-cli/forge-cli-autoinstall-default.js";
import type { ForgeCliId } from "./forge-cli/forge-cli-catalog.js";
import { createGitHubService, probeGitHubHost } from "./github-service.js";
import type { ForgeService } from "./forge-service.js";
import { createGiteaService, resolveGiteaFamilyForge } from "./gitea-service.js";
import { createGitLabService, probeGitLabHost } from "./gitlab-service.js";

/**
 * Real daemon config (paseoHome/logger/auto-install flag), passed down to
 * each adapter's CLI resolver so it doesn't fall back to module-level
 * defaults. Optional because createForgeService("gitlab") with no context
 * still works, it just uses ensureForgeCliWithDefaults's own fallbacks.
 */
export interface ForgeServiceContext {
  paseoHome: string;
  logger: pino.Logger;
  toolsDir?: string;
  forgeCliAutoInstall?: boolean;
}

export type ForgeServiceFactory = (context?: ForgeServiceContext) => ForgeService;

export interface ForgeAdapterRegistration {
  createService: ForgeServiceFactory;
  matchesHost?: (host: string) => boolean;
  probeHost?: (host: string) => Promise<boolean>;
}

/**
 * Open composition boundary for forge adapters. Resolver code depends only on
 * these registration hooks, so a new adapter does not require another branch.
 */
export class ForgeRegistry {
  readonly #adapters = new Map<string, ForgeAdapterRegistration>();
  readonly #warnedAmbiguousHosts = new Set<string>();

  constructor(entries: Iterable<readonly [string, ForgeAdapterRegistration]> = []) {
    for (const [forge, adapter] of entries) {
      this.register(forge, adapter);
    }
  }

  register(forge: string, adapter: ForgeAdapterRegistration): () => void {
    const normalizedForge = parseForgeId(forge);
    if (!normalizedForge) {
      throw new Error(`Invalid forge adapter id: ${forge}`);
    }
    if (this.#adapters.has(normalizedForge)) {
      throw new Error(`Forge adapter already registered: ${normalizedForge}`);
    }
    this.#adapters.set(normalizedForge, adapter);
    return () => {
      if (this.#adapters.get(normalizedForge) === adapter) {
        this.#adapters.delete(normalizedForge);
      }
    };
  }

  ids(): string[] {
    return [...this.#adapters.keys()];
  }

  has(forge: string): boolean {
    const normalizedForge = parseForgeId(forge);
    return normalizedForge ? this.#adapters.has(normalizedForge) : false;
  }

  create(forge: string, context?: ForgeServiceContext): ForgeService | null {
    const normalizedForge = parseForgeId(forge);
    if (!normalizedForge) {
      return null;
    }
    const adapter = this.#adapters.get(normalizedForge);
    return adapter ? adapter.createService(context) : null;
  }

  matchHost(host: string): string | null {
    const matches: string[] = [];
    for (const [forge, adapter] of this.#adapters) {
      if (adapter.matchesHost?.(host)) {
        matches.push(forge);
      }
    }
    if (matches.length > 1) {
      this.#warnAmbiguous("matched", host, matches);
      return null;
    }
    return matches[0] ?? null;
  }

  async probeHost(host: string): Promise<string | null> {
    const entries = [...this.#adapters];
    // allSettled, not all: a third-party probe that throws means "not this
    // forge", never a crash of the shared resolution path.
    const settled = await Promise.allSettled(
      entries.map(async ([, adapter]) =>
        adapter.probeHost ? await adapter.probeHost(host) : false,
      ),
    );
    const matches = entries
      .filter((_, index) => {
        const result = settled[index];
        return result.status === "fulfilled" && result.value === true;
      })
      .map(([forge]) => forge);
    if (matches.length > 1) {
      this.#warnAmbiguous("recognized", host, matches);
      return null;
    }
    return matches[0] ?? null;
  }

  // Genuine ambiguity (two adapters both claiming a host) degrades to "no
  // forge" rather than crashing the shared resolution path used by every
  // workspace's PR-status poll; warn once per host so the misconfiguration
  // is still visible.
  #warnAmbiguous(verb: string, host: string, matches: string[]): void {
    const key = `${verb}:${host}`;
    if (this.#warnedAmbiguousHosts.has(key)) {
      return;
    }
    this.#warnedAmbiguousHosts.add(key);
    console.warn(`Multiple forge adapters ${verb} host ${host}: ${matches.join(", ")}`);
  }
}

function parseForgeId(forge: string): string | null {
  const normalized = forge.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]*$/.test(normalized) ? normalized : null;
}

/**
 * Build a host matcher from a forge's declared cloud hosts in the manifest, so
 * the registry never hardcodes a host list. Returns undefined for forges with
 * no cloud hosts (recognized only by runtime probe, e.g. Forgejo).
 */
function matchesCloudHost(forgeId: string): ((host: string) => boolean) | undefined {
  const hosts = getForgeDefinition(forgeId)?.cloudHosts;
  if (!hosts || hosts.length === 0) {
    return undefined;
  }
  const normalized = new Set(hosts.map(normalizeHost));
  return (host) => normalized.has(normalizeHost(host));
}

// Wraps resolveForgeCliPath (the single PATH-then-install resolver, shared
// with github-service.ts/gitlab-service.ts/gitea-service.ts's own bare
// resolveXPath fallbacks) with whatever context this registry call has.
function resolveCliPathWithAutoInstall(
  cli: ForgeCliId,
  context: ForgeServiceContext | undefined,
): () => Promise<string | null> {
  return () =>
    resolveForgeCliPath(cli, {
      paseoHome: context?.paseoHome,
      logger: context?.logger,
      toolsDir: context?.toolsDir,
      autoInstallEnabled: context?.forgeCliAutoInstall,
    });
}

export const defaultForgeRegistry = new ForgeRegistry([
  // GitHub Enterprise Server is recognized at runtime by probeHost, exactly like
  // self-hosted GitLab/Gitea: github.com short-circuits via matchHost, so the
  // probe only runs on non-cloud hosts. The PR-status poll gates on the resolver
  // alone (no cloud-identity check), so a probed GHES host polls normally.
  [
    "github",
    {
      createService: (context) =>
        createGitHubService({ resolveGhPath: resolveCliPathWithAutoInstall("gh", context) }),
      matchesHost: matchesCloudHost("github"),
      probeHost: probeGitHubHost,
    },
  ],
  [
    "gitlab",
    {
      createService: (context) =>
        createGitLabService({ resolveGlabPath: resolveCliPathWithAutoInstall("glab", context) }),
      matchesHost: matchesCloudHost("gitlab"),
      probeHost: probeGitLabHost,
    },
  ],
  [
    "gitea",
    {
      createService: (context) =>
        createGiteaService({ resolveTeaPath: resolveCliPathWithAutoInstall("tea", context) }),
      matchesHost: matchesCloudHost("gitea"),
      probeHost: async (host) => (await resolveGiteaFamilyForge(host)) === "gitea",
    },
  ],
  [
    "forgejo",
    {
      createService: (context) =>
        createGiteaService({ resolveTeaPath: resolveCliPathWithAutoInstall("tea", context) }),
      probeHost: async (host) => (await resolveGiteaFamilyForge(host)) === "forgejo",
    },
  ],
  [
    "codeberg",
    {
      createService: (context) =>
        createGiteaService({ resolveTeaPath: resolveCliPathWithAutoInstall("tea", context) }),
      matchesHost: matchesCloudHost("codeberg"),
    },
  ],
]);

export function createForgeService(
  forge: string,
  context?: ForgeServiceContext,
): ForgeService | null {
  return defaultForgeRegistry.create(forge, context);
}

export function probeRegisteredForgeHost(host: string): Promise<string | null> {
  return defaultForgeRegistry.probeHost(host);
}
