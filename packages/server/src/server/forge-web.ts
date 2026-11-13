import { forgeWebHost } from "@getpaseo/protocol/git-remote";
import type { ForgeWeb } from "@getpaseo/protocol/messages";
import type { ForgeResolution } from "../services/forge-resolver.js";

// A failed reference-repository lookup (network down, rate limit) is retried after this long.
const REFERENCE_REPOSITORY_RETRY_MS = 60_000;

/**
 * Web location of a workspace's forge, remembered per origin remote. The host
 * comes from the forge resolution; the reference repository needs the forge, so
 * it is looked up once per remote and again only on a forced refresh or after a
 * failed lookup.
 */
export interface ForgeWebEntry {
  remoteKey: string;
  forgeWeb: ForgeWeb;
  retryAtMs: number | null;
}

export async function resolveForgeWeb(input: {
  cwd: string;
  remoteUrl: string;
  resolution: ForgeResolution;
  /** Whether the forge CLI is signed in; an unauthenticated lookup would only fail. */
  authenticated: boolean;
  previous: ForgeWebEntry | null;
  force: boolean;
  nowMs: number;
}): Promise<ForgeWebEntry> {
  const remoteKey = `${input.resolution.forge}\0${input.remoteUrl}`;
  const host = forgeWebHost(input.resolution.forge, input.resolution.host);
  const previous = input.previous?.remoteKey === remoteKey ? input.previous : null;
  if (
    previous &&
    !input.force &&
    (previous.retryAtMs === null || input.nowMs < previous.retryAtMs)
  ) {
    return previous;
  }

  const lookup = input.resolution.service.getReferenceRepository;
  if (!lookup) {
    return { remoteKey, forgeWeb: { host }, retryAtMs: null };
  }
  if (!input.authenticated) {
    return {
      remoteKey,
      forgeWeb: { host },
      retryAtMs: input.nowMs + REFERENCE_REPOSITORY_RETRY_MS,
    };
  }
  // The links still work without a reference repository, so a failed lookup is retried later, not surfaced.
  try {
    const referenceRepository = await lookup.call(input.resolution.service, { cwd: input.cwd });
    return {
      remoteKey,
      forgeWeb: referenceRepository ? { host, referenceRepository } : { host },
      retryAtMs: null,
    };
  } catch {
    return {
      remoteKey,
      forgeWeb: { host },
      retryAtMs: input.nowMs + REFERENCE_REPOSITORY_RETRY_MS,
    };
  }
}
