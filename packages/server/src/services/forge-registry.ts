import {
  getForgeDefinition,
  getForgeDefinitionOrNeutral,
  type ForgeDefinition,
} from "@getpaseo/protocol/forge-manifest";
import { normalizeHost } from "@getpaseo/protocol/git-remote";
import { createGitHubService, probeGitHubHost } from "./github-service.js";
import type { ForgeService } from "./forge-service.js";
import { createGiteaService, resolveGiteaFamilyForge } from "./gitea-service.js";
import { createGitLabService, probeGitLabHost } from "./gitlab-service.js";

export type ForgeServiceFactory = () => ForgeService;

export interface ForgeAdapterRegistration {
  createService: ForgeServiceFactory;
  definition?: ForgeDefinition;
  matchesHost?: (host: string) => boolean;
  probeHost?: (host: string) => Promise<boolean>;
}

export interface ForgeRegistryChange {
  forge: string;
  registered: boolean;
  revision: number;
}

export type ForgeHostMatch =
  | { kind: "none" }
  | { kind: "unique"; forge: string }
  | { kind: "ambiguous"; forges: string[] };

interface RegisteredForgeAdapter {
  adapter: ForgeAdapterRegistration;
  revision: number;
}

/**
 * Open composition boundary for forge adapters. Resolver code depends only on
 * these registration hooks, so a new adapter does not require another branch.
 */
export class ForgeRegistry {
  readonly #adapters = new Map<string, RegisteredForgeAdapter>();
  readonly #warnedAmbiguousHosts = new Set<string>();
  readonly #listeners = new Set<(change: ForgeRegistryChange) => void>();
  #revision = 0;

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
    const registered = {
      adapter: {
        ...adapter,
        ...(adapter.definition
          ? { definition: cloneForgeDefinition({ ...adapter.definition, id: normalizedForge }) }
          : {}),
      },
      revision: ++this.#revision,
    };
    this.#adapters.set(normalizedForge, registered);
    this.#warnedAmbiguousHosts.clear();
    this.#notify({ forge: normalizedForge, registered: true, revision: this.#revision });
    return () => {
      if (this.#adapters.get(normalizedForge) === registered) {
        this.#adapters.delete(normalizedForge);
        this.#revision += 1;
        this.#warnedAmbiguousHosts.clear();
        this.#notify({ forge: normalizedForge, registered: false, revision: this.#revision });
      }
    };
  }

  subscribe(listener: (change: ForgeRegistryChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  revision(): number {
    return this.#revision;
  }

  adapterRevision(forge: string): number | null {
    const normalizedForge = parseForgeId(forge);
    return normalizedForge ? (this.#adapters.get(normalizedForge)?.revision ?? null) : null;
  }

  ids(): string[] {
    return [...this.#adapters.keys()];
  }

  has(forge: string): boolean {
    const normalizedForge = parseForgeId(forge);
    return normalizedForge ? this.#adapters.has(normalizedForge) : false;
  }

  definition(forge: string): ForgeDefinition | null {
    const normalizedForge = parseForgeId(forge);
    if (!normalizedForge) return null;
    const registeredDefinition = this.#adapters.get(normalizedForge)?.adapter.definition;
    const definition = registeredDefinition ?? getForgeDefinition(normalizedForge);
    return definition ? cloneForgeDefinition(definition) : null;
  }

  definitionOrNeutral(forge: string): ForgeDefinition {
    return this.definition(forge) ?? getForgeDefinitionOrNeutral(forge);
  }

  create(forge: string): ForgeService | null {
    const normalizedForge = parseForgeId(forge);
    if (!normalizedForge) {
      return null;
    }
    const registered = this.#adapters.get(normalizedForge);
    return registered ? registered.adapter.createService() : null;
  }

  matchHost(host: string): string | null {
    const match = this.classifyHost(host);
    return match.kind === "unique" ? match.forge : null;
  }

  classifyHost(host: string): ForgeHostMatch {
    const matches: string[] = [];
    for (const [forge, { adapter }] of this.#adapters) {
      if (adapter.matchesHost?.(host)) {
        matches.push(forge);
      }
    }
    if (matches.length > 1) {
      this.#warnAmbiguous("matched", host, matches);
      return { kind: "ambiguous", forges: matches };
    }
    const forge = matches[0];
    return forge ? { kind: "unique", forge } : { kind: "none" };
  }

  async probeHost(host: string): Promise<string | null> {
    const entries = [...this.#adapters];
    // allSettled, not all: a third-party probe that throws means "not this
    // forge", never a crash of the shared resolution path.
    const settled = await Promise.allSettled(
      entries.map(async ([, { adapter }]) =>
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

  #notify(change: ForgeRegistryChange): void {
    for (const listener of this.#listeners) {
      try {
        listener(change);
      } catch (error) {
        console.warn(`Forge registry listener failed: ${String(error)}`);
      }
    }
  }
}

function parseForgeId(forge: string): string | null {
  const normalized = forge.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]*$/.test(normalized) ? normalized : null;
}

function cloneForgeDefinition(definition: ForgeDefinition): ForgeDefinition {
  return {
    ...definition,
    signIn: definition.signIn ? { ...definition.signIn } : null,
    ...(definition.cloudHosts ? { cloudHosts: [...definition.cloudHosts] } : {}),
  };
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

function defaultForgeRegistryEntries(): Array<readonly [string, ForgeAdapterRegistration]> {
  return [
    // GitHub Enterprise Server is recognized at runtime by probeHost, exactly like
    // self-hosted GitLab/Gitea: github.com short-circuits via matchHost, so the
    // probe only runs on non-cloud hosts. The PR-status poll gates on the resolver
    // alone (no cloud-identity check), so a probed GHES host polls normally.
    [
      "github",
      {
        createService: createGitHubService,
        matchesHost: matchesCloudHost("github"),
        probeHost: probeGitHubHost,
      },
    ],
    [
      "gitlab",
      {
        createService: createGitLabService,
        matchesHost: matchesCloudHost("gitlab"),
        probeHost: probeGitLabHost,
      },
    ],
    [
      "gitea",
      {
        createService: createGiteaService,
        matchesHost: matchesCloudHost("gitea"),
        probeHost: async (host) => (await resolveGiteaFamilyForge(host)) === "gitea",
      },
    ],
    [
      "forgejo",
      {
        createService: createGiteaService,
        probeHost: async (host) => (await resolveGiteaFamilyForge(host)) === "forgejo",
      },
    ],
    ["codeberg", { createService: createGiteaService, matchesHost: matchesCloudHost("codeberg") }],
  ];
}

export function createDefaultForgeRegistry(): ForgeRegistry {
  return new ForgeRegistry(defaultForgeRegistryEntries());
}

export const defaultForgeRegistry = createDefaultForgeRegistry();

export function createForgeService(forge: string): ForgeService | null {
  return defaultForgeRegistry.create(forge);
}

export function probeRegisteredForgeHost(host: string): Promise<string | null> {
  return defaultForgeRegistry.probeHost(host);
}
