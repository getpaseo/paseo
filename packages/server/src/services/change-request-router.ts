import { normalizeHost } from "@getpaseo/protocol/git-remote";
import type { ChangeRequestSource } from "./change-request-source.js";
import type { ForgeResolver } from "./forge-resolver.js";

export interface ResolvedChangeRequest {
  forge: string;
  url: string;
}

export interface ChangeRequestRouter {
  /** Route a user-supplied URL host-first through registered forges and canonicalize it. */
  resolve(url: string): Promise<ResolvedChangeRequest>;
  /** Return the watch source for a known forge id without probing the network. */
  source(forge: string): ChangeRequestSource | null;
}

export interface CreateChangeRequestRouterOptions {
  forgeResolver: Pick<ForgeResolver, "resolveHost" | "getService">;
}

function extractUrlHost(input: string): { trimmed: string; host: string; authority: string } {
  const trimmed = input.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    throw new Error("Enter a supported change request URL.");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Enter a supported change request URL.");
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("Enter a supported change request URL.");
  }
  const host = normalizeHost(parsed.hostname);
  if (!host) {
    throw new Error("Enter a supported change request URL.");
  }
  return { trimmed, host, authority: parsed.port ? `${host}:${parsed.port}` : host };
}

/**
 * Host-first router for change request watches. Resolves the target forge from
 * the URL host via ForgeResolver (cloud match first, then cached CLI auth
 * probe) before delegating path parsing and canonicalization to that forge's
 * ChangeRequestSource.
 */
export function createChangeRequestRouter({
  forgeResolver,
}: CreateChangeRequestRouterOptions): ChangeRequestRouter {
  return {
    async resolve(input: string): Promise<ResolvedChangeRequest> {
      const { trimmed, host, authority } = extractUrlHost(input);
      const resolution =
        (await forgeResolver.resolveHost(authority)) ??
        (authority === host ? null : await forgeResolver.resolveHost(host));
      if (!resolution) {
        throw new Error(
          `Could not recognize a supported forge for host ${host}. Authenticate the forge CLI for this host first.`,
        );
      }
      const source = resolution.service.changeRequests;
      if (!source) {
        throw new Error(`Change request watches are not supported for ${resolution.forge} yet.`);
      }
      return {
        forge: resolution.forge,
        url: source.resolve(trimmed),
      };
    },

    source(forge: string): ChangeRequestSource | null {
      return forgeResolver.getService(forge)?.changeRequests ?? null;
    },
  };
}
