import { LRUCache } from "lru-cache";
import { parseGitRemoteLocation, type GitRemoteLocation } from "@getpaseo/protocol/git-remote";
import { resolveSshHostname, type SshHostnameResolver } from "../utils/ssh-hostname.js";
import { defaultResolveRemoteUrl } from "./forge-cli-command.js";
import type { ForgeService } from "./forge-service.js";
import {
  createForgeService,
  defaultForgeRegistry,
  probeRegisteredForgeHost,
} from "./forge-registry.js";

export interface ForgeResolution {
  /** Registered forge id, e.g. "github" or "gitlab". */
  forge: string;
  /** Remote host the cwd resolves to, e.g. "github.com" or "gitlab.example.com". */
  host: string;
  /** Adapter for {@link forge}, shared across resolutions of the same forge. */
  service: ForgeService;
}

/** Probe a host for a forge id when the name heuristic is inconclusive. */
export type ForgeHostProbe = (host: string) => Promise<string | null>;

export interface CreateForgeResolverOptions {
  resolveRemoteUrl?: (cwd: string) => Promise<string | null>;
  createService?: (forge: string) => ForgeService | null;
  probeForge?: ForgeHostProbe;
  resolveSshHostname?: SshHostnameResolver;
  now?: () => number;
}

export interface ForgeResolver {
  /** Resolve the forge for a working directory, or null when none applies. */
  resolve(cwd: string): Promise<ForgeResolution | null>;
  /** Resolve from a known origin remote URL using only the name heuristic + probe cache. */
  resolveFromRemoteUrl(remoteUrl: string | null): ForgeResolution | null;
  /** Resolve from a known origin remote URL, running the per-host probe when needed. */
  resolveFromRemoteUrlAsync(remoteUrl: string | null): Promise<ForgeResolution | null>;
  /**
   * Invalidate every cached adapter's state for a cwd. Routed through the
   * resolver so invalidation hits the same adapter instance the poller reads,
   * regardless of which forge backs the workspace.
   */
  invalidate(cwd: string): void;
}

// A positive probe (host IS a known forge) is cached permanently; a negative one
// expires so a CLI installed/authenticated later is picked up without a restart.
const NEGATIVE_PROBE_TTL_MS = 60_000;
// Cap the per-resolver caches: session handlers resolve request-supplied cwds,
// so unbounded Maps would grow for the daemon's lifetime. Distinct hosts/cwds
// are few in practice; LRU eviction keeps the working set without a leak.
const FORGE_RESOLVER_CACHE_MAX = 512;

export function parseRemoteHost(url: string): string | null {
  return parseGitRemoteLocation(url)?.host ?? null;
}

/** Map a remote host through the matchers owned by registered adapters. */
export function forgeForHost(host: string): string | null {
  return defaultForgeRegistry.matchHost(host);
}

export function createForgeResolver(options: CreateForgeResolverOptions = {}): ForgeResolver {
  const resolveRemoteUrl = options.resolveRemoteUrl ?? defaultResolveRemoteUrl;
  const create = options.createService ?? createForgeService;
  const probeForge = options.probeForge ?? probeRegisteredForgeHost;
  const resolveSsh = options.resolveSshHostname ?? resolveSshHostname;
  const now = options.now ?? Date.now;
  const services = new Map<string, ForgeService>();
  // Cache the per-host probe result so the synchronous resolveFromRemoteUrl can
  // reuse a forge discovered by an earlier async resolve. Positive results are
  // permanent; negative ones expire (NEGATIVE_PROBE_TTL_MS) so a CLI installed
  // or authenticated later is picked up without a daemon restart.
  const probedForgeByHost = new LRUCache<
    string,
    { forge: string | null; expiresAt: number | null }
  >({ max: FORGE_RESOLVER_CACHE_MAX });
  // Coalesce concurrent probes of the same host so "never re-probe" holds under
  // concurrency: callers racing on the same host await one shared probe.
  const inFlightProbes = new Map<string, Promise<string | null>>();
  // resolveRemoteUrl spawns `git config` — memoize per cwd so repeated resolve()
  // calls (the PR-status poll hits this every cycle) don't re-spawn it. TTL'd
  // (not permanent, unlike a positive host probe) so a remote added/changed
  // from outside Paseo — `git remote add`/`set-url` run in a terminal — is
  // still picked up within a cycle instead of staying pinned forever; a Paseo
  // git mutation still busts it immediately via invalidate(cwd).
  const remoteUrlByCwd = new LRUCache<
    string,
    { promise: Promise<string | null>; expiresAt: number }
  >({ max: FORGE_RESOLVER_CACHE_MAX });

  function resolveRemoteUrlCached(cwd: string): Promise<string | null> {
    const cached = remoteUrlByCwd.get(cwd);
    if (cached && cached.expiresAt > now()) {
      return cached.promise;
    }
    const pending = resolveRemoteUrl(cwd).catch((error: unknown) => {
      if (remoteUrlByCwd.get(cwd)?.promise === pending) {
        remoteUrlByCwd.delete(cwd);
      }
      throw error;
    });
    remoteUrlByCwd.set(cwd, { promise: pending, expiresAt: now() + NEGATIVE_PROBE_TTL_MS });
    return pending;
  }

  function readFreshProbe(host: string): string | null | undefined {
    const entry = probedForgeByHost.get(host);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
      probedForgeByHost.delete(host);
      return undefined;
    }
    return entry.forge;
  }

  function buildResolution(forge: string, host: string): ForgeResolution | null {
    let service = services.get(forge);
    if (!service) {
      const created = create(forge);
      if (!created) {
        return null;
      }
      service = created;
      services.set(forge, service);
    }
    return { forge, host, service };
  }

  async function probeHostForge(host: string): Promise<string | null> {
    const cached = readFreshProbe(host);
    if (cached !== undefined) {
      return cached;
    }
    const existing = inFlightProbes.get(host);
    if (existing) {
      return existing;
    }
    const pending = (async () => {
      try {
        // A caller-injected probe that throws degrades to "no forge" and is
        // cached negatively, so a transient failure is retried after the TTL.
        let probed: string | null;
        try {
          probed = await probeForge(host);
        } catch {
          probed = null;
        }
        probedForgeByHost.set(host, {
          forge: probed,
          expiresAt: probed === null ? Date.now() + NEGATIVE_PROBE_TTL_MS : null,
        });
        return probed;
      } finally {
        inFlightProbes.delete(host);
      }
    })();
    inFlightProbes.set(host, pending);
    return pending;
  }

  function resolveFromRemoteUrl(remoteUrl: string | null): ForgeResolution | null {
    if (!remoteUrl) {
      return null;
    }
    const host = parseRemoteHost(remoteUrl);
    if (!host) {
      return null;
    }
    const forge = forgeForHost(host) ?? readFreshProbe(host) ?? null;
    if (!forge) {
      return null;
    }
    return buildResolution(forge, host);
  }

  async function resolveFromRemoteUrlAsync(
    remoteUrl: string | null,
  ): Promise<ForgeResolution | null> {
    if (!remoteUrl) {
      return null;
    }
    const location = parseGitRemoteLocation(remoteUrl);
    if (!location) {
      return null;
    }
    const directForge = forgeForHost(location.host);
    if (directForge) {
      return buildResolution(directForge, location.host);
    }

    const resolved = await resolveHostForProbe(location);
    if (resolved.forge) {
      rememberAliasForge(location.host, resolved.host, resolved.forge);
      return buildResolution(resolved.forge, resolved.host);
    }

    const forge = await probeHostForge(resolved.host);
    rememberAliasForge(location.host, resolved.host, forge);
    if (!forge) {
      return null;
    }
    return buildResolution(forge, resolved.host);
  }

  // Seed the probe cache under the raw SSH-alias host too: the synchronous
  // resolveFromRemoteUrl (PR-status poll gating) sees the alias, not the
  // ssh -G resolved host, and would otherwise never find the forge.
  function rememberAliasForge(aliasHost: string, resolvedHost: string, forge: string | null): void {
    if (aliasHost === resolvedHost) {
      return;
    }
    probedForgeByHost.set(aliasHost, {
      forge,
      expiresAt: forge === null ? Date.now() + NEGATIVE_PROBE_TTL_MS : null,
    });
  }

  async function resolveHostForProbe(
    location: GitRemoteLocation,
  ): Promise<{ host: string; forge?: string }> {
    if (location.transport !== "scp" && location.transport !== "ssh") {
      return { host: location.host };
    }

    const resolvedHost = await resolveSsh(location.host);
    if (!resolvedHost) {
      return { host: location.host };
    }

    const resolvedForge = forgeForHost(resolvedHost);
    if (resolvedForge) {
      return { host: resolvedHost, forge: resolvedForge };
    }

    return { host: resolvedHost };
  }

  function invalidate(cwd: string): void {
    remoteUrlByCwd.delete(cwd);
    for (const service of services.values()) {
      service.invalidate({ cwd });
    }
  }

  return {
    resolveFromRemoteUrl,
    resolveFromRemoteUrlAsync,
    invalidate,
    async resolve(cwd: string): Promise<ForgeResolution | null> {
      return resolveFromRemoteUrlAsync(await resolveRemoteUrlCached(cwd));
    },
  };
}
