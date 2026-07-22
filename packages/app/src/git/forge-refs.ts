import { FORGE_DEFINITIONS } from "@getpaseo/protocol/forge-manifest";
import { normalizeHost, parseGitRemoteLocation } from "@getpaseo/protocol/git-remote";
import type { ForgeReferencePath } from "@/git/client-forge-module";
import { CLIENT_FORGE_LOGIC_MODULES } from "@/git/forges";

export interface ForgeRef {
  kind: ForgeReferencePath["kind"];
  number: number;
}

const WEB_URL_PATTERN = /https?:\/\/[^\s<>"'`)\]]+/giu;
const TRAILING_SENTENCE_PUNCTUATION = /[.,;:!]+$/u;

interface RemoteReferenceTarget {
  webHosts: ReadonlySet<string>;
  repoPath: string;
  /** Known cloud forge ids, or null when a self-hosted domain is unresolved. */
  forgeIds: ReadonlySet<string> | null;
}

/**
 * Finds issue and change-request URLs belonging to the current repository.
 * Route syntax comes entirely from the app forge registry: adding a forge's
 * `urlGrammar.referencePaths` makes composer auto-attachment work without a
 * central forge switch.
 */
export function extractForgeRefs(
  text: string | null | undefined,
  remoteUrl: string | null | undefined,
): ForgeRef[] {
  const target = resolveRemoteReferenceTarget(remoteUrl);
  const body = text?.trim();
  if (!target || !body) {
    return [];
  }

  const refs: ForgeRef[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(WEB_URL_PATTERN)) {
    const candidate = parsePastedWebUrl(match[0]);
    if (!candidate || !target.webHosts.has(normalizeHost(candidate.hostname))) {
      continue;
    }
    const pathname = decodePathname(candidate.pathname);
    if (!pathname) {
      continue;
    }
    for (const referencePath of registeredReferencePaths(target.forgeIds)) {
      const ref = parseReferencePath(pathname, target.repoPath, referencePath);
      if (!ref) {
        continue;
      }
      const key = forgeRefKey(ref);
      if (!seen.has(key)) {
        seen.add(key);
        refs.push(ref);
      }
      break;
    }
  }
  return refs;
}

export function parseForgeRef(
  text: string | null | undefined,
  remoteUrl: string | null | undefined,
): ForgeRef | null {
  return extractForgeRefs(text, remoteUrl)[0] ?? null;
}

function resolveRemoteReferenceTarget(
  remoteUrl: string | null | undefined,
): RemoteReferenceTarget | null {
  if (!remoteUrl) {
    return null;
  }
  const remote = parseGitRemoteLocation(remoteUrl);
  if (!remote) {
    return null;
  }

  const webHosts = new Set([remote.host]);
  const forgeIds = new Set<string>();
  for (const definition of FORGE_DEFINITIONS) {
    const cloudHosts = definition.cloudHosts?.map(normalizeHost) ?? [];
    if (cloudHosts.includes(remote.host) && cloudHosts[0]) {
      forgeIds.add(definition.id);
      webHosts.add(cloudHosts[0]);
    }
  }
  return {
    webHosts,
    repoPath: remote.path,
    forgeIds: forgeIds.size > 0 ? forgeIds : null,
  };
}

function parsePastedWebUrl(raw: string): URL | null {
  try {
    const parsed = new URL(raw.replace(TRAILING_SENTENCE_PUNCTUATION, ""));
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

function decodePathname(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

function registeredReferencePaths(
  forgeIds: ReadonlySet<string> | null,
): readonly ForgeReferencePath[] {
  return CLIENT_FORGE_LOGIC_MODULES.flatMap((module) =>
    !forgeIds || forgeIds.has(module.id) ? (module.urlGrammar?.referencePaths ?? []) : [],
  );
}

function parseReferencePath(
  pathname: string,
  repoPath: string,
  referencePath: ForgeReferencePath,
): ForgeRef | null {
  const prefix = `/${repoPath}${referencePath.infix}`;
  if (!pathname.toLowerCase().startsWith(prefix.toLowerCase())) {
    return null;
  }
  const suffix = pathname.slice(prefix.length);
  const numberText = suffix.match(/^(\d+)(?:\/|$)/u)?.[1];
  if (!numberText) {
    return null;
  }
  const number = Number.parseInt(numberText, 10);
  return Number.isSafeInteger(number) && number > 0 ? { kind: referencePath.kind, number } : null;
}

function forgeRefKey(ref: ForgeRef): string {
  return `${ref.kind}:${ref.number}`;
}
