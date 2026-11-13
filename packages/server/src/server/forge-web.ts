import { forgeWebHost } from "@getpaseo/protocol/git-remote";
import type { ForgeWeb } from "@getpaseo/protocol/messages";
import type { ForgeResolution } from "../services/forge-resolver.js";

// A failed reference-repository lookup (signed out, network down, rate limit) is retried after this long.
const REFERENCE_REPOSITORY_RETRY_MS = 60_000;

/**
 * Web location of a workspace's forge, remembered per origin remote. The host
 * comes from the forge resolution; the reference repository needs the forge, so
 * it is looked up once per remote, and again only after a failed lookup, when a
 * forced refresh or the retry delay allows.
 */
export interface ForgeWebEntry {
  remoteUrl: string;
  remoteKey: string;
  forgeWeb: ForgeWeb;
  retryAtMs: number | null;
}

export async function resolveForgeWeb(input: {
  cwd: string;
  remoteUrl: string;
  resolution: ForgeResolution;
  previous: ForgeWebEntry | null;
  force: boolean;
  nowMs: number;
}): Promise<ForgeWebEntry> {
  const remoteKey = `${input.resolution.forge}\0${input.remoteUrl}`;
  const host = forgeWebHost(input.resolution.forge, input.resolution.host);
  const previous = input.previous?.remoteKey === remoteKey ? input.previous : null;
  // A settled lookup stands for as long as the remote does: a repository's parent
  // almost never changes, and forced refreshes (every push, fetch and branch switch) are frequent.
  if (
    previous &&
    (previous.retryAtMs === null || (!input.force && input.nowMs < previous.retryAtMs))
  ) {
    return previous;
  }

  const lookup = input.resolution.service.getReferenceRepository;
  if (!lookup) {
    return { remoteUrl: input.remoteUrl, remoteKey, forgeWeb: { host }, retryAtMs: null };
  }
  // The links still work without a reference repository, so a failed lookup is retried later, not surfaced.
  try {
    const referenceRepository = await lookup.call(input.resolution.service, { cwd: input.cwd });
    return {
      remoteUrl: input.remoteUrl,
      remoteKey,
      forgeWeb: referenceRepository ? { host, referenceRepository } : { host },
      retryAtMs: null,
    };
  } catch {
    return {
      remoteUrl: input.remoteUrl,
      remoteKey,
      forgeWeb: { host },
      retryAtMs: input.nowMs + REFERENCE_REPOSITORY_RETRY_MS,
    };
  }
}
