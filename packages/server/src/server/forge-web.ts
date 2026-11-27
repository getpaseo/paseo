import { forgeWebHost } from "@getpaseo/protocol/git-remote";
import type { ForgeWeb } from "@getpaseo/protocol/messages";
import type { ForgeResolution } from "../services/forge-resolver.js";

// A failed reference-repository lookup (signed out, network down, rate limit) is retried after this long.
const REFERENCE_REPOSITORY_RETRY_MS = 60_000;

/**
 * Web location of a workspace's forge, remembered per origin remote. The host
 * comes from the forge resolution; the reference repository needs the forge, so
 * it is looked up once per remote, and again only after a failed lookup, once
 * the retry delay has passed.
 */
export interface ForgeWebEntry {
  remoteUrl: string;
  remoteKey: string;
  forgeWeb: ForgeWeb;
  retryAtMs: number | null;
}

/**
 * The web location available without the forge lookup: a settled answer for this
 * remote, or the host alone while its reference repository is due. Publish this
 * with the snapshot immediately; a slow or signed-out forge CLI must not hold
 * back the workspace's git state or pull request status.
 */
export function forgeWebForResolution(input: {
  remoteUrl: string;
  resolution: ForgeResolution;
  previous: ForgeWebEntry | null;
  nowMs: number;
}): ForgeWebEntry {
  const remoteKey = `${input.resolution.forge}\0${input.remoteUrl}`;
  const previous = input.previous?.remoteKey === remoteKey ? input.previous : null;
  // A settled lookup stands for as long as the remote does, and a failed one keeps its retry
  // time, however often forced refreshes (every push, fetch and branch switch) ask.
  if (previous) {
    return previous;
  }
  return {
    remoteUrl: input.remoteUrl,
    remoteKey,
    forgeWeb: { host: forgeWebHost(input.resolution.forge, input.resolution.host) },
    // A lookup that has never run is due now; one that failed keeps its own retry time.
    retryAtMs: input.resolution.service.getReferenceRepository ? input.nowMs : null,
  };
}

/**
 * Enriches an entry with the repository that owns issue and change-request
 * numbers. The links still work without it, so a failed lookup is retried later
 * rather than surfaced.
 */
export async function resolveForgeWebReference(input: {
  cwd: string;
  resolution: ForgeResolution;
  entry: ForgeWebEntry;
  nowMs: number;
}): Promise<ForgeWebEntry> {
  const host = input.entry.forgeWeb.host;
  const lookup = input.resolution.service.getReferenceRepository;
  if (!lookup) {
    return input.entry.retryAtMs === null ? input.entry : { ...input.entry, retryAtMs: null };
  }
  try {
    const referenceRepository = await lookup.call(input.resolution.service, { cwd: input.cwd });
    return {
      ...input.entry,
      forgeWeb: referenceRepository ? { host, referenceRepository } : { host },
      retryAtMs: null,
    };
  } catch {
    return {
      ...input.entry,
      forgeWeb: { host },
      retryAtMs: input.nowMs + REFERENCE_REPOSITORY_RETRY_MS,
    };
  }
}
