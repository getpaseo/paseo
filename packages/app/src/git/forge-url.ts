/**
 * Forge-neutral web URL builders for "Open on <forge>" actions (a file blob or a
 * branch tree). The host comes from the workspace remote — not a hardcoded
 * cloud host — so self-hosted and Enterprise instances link correctly. Each
 * forge contributes a small URL grammar (the path infixes and line-anchor
 * format); an unknown forge has no grammar and yields null, so the action is
 * simply absent rather than wrong.
 *
 * URL grammar lives on each client forge module. The daemon resolves the web
 * host (SSH config aliases, cloud SSH hosts) and the repository that owns
 * issue and change-request numbers (a fork's parent) and publishes them as
 * `forgeWeb`; branch and file links stay on the origin repository.
 */
import {
  forgeWebHost,
  isForgeCloudHost,
  parseGitRemoteLocation,
} from "@getpaseo/protocol/git-remote";
import type { ForgeWeb } from "@getpaseo/protocol/messages";
import type { ForgeReferenceSigil } from "@/git/client-forge-module";
import { getClientForgeLogicModule } from "@/git/forges";

export interface ForgeBlobUrlInput {
  remoteUrl: string | null | undefined;
  forgeWeb?: ForgeWeb | null;
  branch: string | null | undefined;
  path: string | null | undefined;
  lineStart?: number;
  lineEnd?: number;
}

export interface ForgeBranchTreeUrlInput {
  remoteUrl: string | null | undefined;
  forgeWeb?: ForgeWeb | null;
  branch: string | null | undefined;
}

export interface ForgeReferenceUrlInput {
  remoteUrl: string | null | undefined;
  forgeWeb?: ForgeWeb | null;
  /**
   * Repository path of a cross-repository reference; the repository that owns
   * issue numbers (`forgeWeb.referenceRepository`, else the remote's) when absent.
   */
  repo?: string | null;
  sigil: ForgeReferenceSigil;
  number: number;
}

export function buildForgeChecksUrl(forge: string, changeRequestUrl: string): string | null {
  const suffix = getClientForgeLogicModule(forge)?.urlGrammar?.changeRequestChecksSuffix;
  if (!suffix) {
    return null;
  }
  try {
    const url = new URL(changeRequestUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    url.pathname = `${url.pathname.replace(/\/$/, "")}${suffix}`;
    return url.toString();
  } catch {
    return null;
  }
}

interface ForgeWebLocation {
  /** "http" only for a self-hosted http:// remote; every other remote browses over https. */
  scheme: "http" | "https";
  host: string;
  /** Non-default port for a self-hosted http(s) origin, or undefined. */
  port?: string;
  repo: string;
}

function isValidRepoPath(path: string): boolean {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return false;
  }
  return !segments.includes("..");
}

/**
 * Web location of the origin repository. The host is the daemon's
 * `forgeWeb.host`. A daemon without `forgeWeb` publishes none, so the remote's
 * own host is used, with a cloud SSH alias mapped to the forge's web host.
 * The repo path supports nested groups (e.g. GitLab subgroups) since it is
 * the full remote path.
 */
function resolveForgeWebLocation(
  forge: string,
  remoteUrl: string | null | undefined,
  forgeWeb: ForgeWeb | null | undefined,
): ForgeWebLocation | null {
  if (!remoteUrl) {
    return null;
  }
  const location = parseGitRemoteLocation(remoteUrl);
  if (!location || !isValidRepoPath(location.path)) {
    return null;
  }
  // COMPAT(forgeWeb): added in v0.16.0, remove the remote-derived host after 2027-06-01 once daemon floor >= v0.16.0.
  const webHost = forgeWeb?.host ?? forgeWebHost(forge, location.host);
  const isCloudHost = isForgeCloudHost(forge, location.host);
  // Carry a non-default port only for a self-hosted http(s) origin (e.g.
  // `:60443`): the web UI shares that origin. An SSH/scp remote's port is not the
  // web port, and a canonicalized cloud host always serves on the default port.
  const port =
    !isCloudHost && (location.transport === "http" || location.transport === "https")
      ? location.port
      : undefined;
  const scheme = !isCloudHost && location.transport === "http" ? "http" : "https";
  return { scheme, host: webHost, port, repo: location.path };
}

function encodeBranch(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

/** Scheme and host, plus `:port` when the remote pins a non-default port. */
function forgeOrigin(location: ForgeWebLocation): string {
  const authority = location.port ? `${location.host}:${location.port}` : location.host;
  return `${location.scheme}://${authority}`;
}

function normalizeBlobPath(path: string | null | undefined): string | null {
  const segments: string[] = [];
  const trimmed = path?.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!trimmed) {
    return null;
  }
  for (const segment of trimmed.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        return null;
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/") || null;
}

export function buildForgeBranchTreeUrl(
  forge: string,
  input: ForgeBranchTreeUrlInput,
): string | null {
  const grammar = getClientForgeLogicModule(forge)?.urlGrammar;
  const location = resolveForgeWebLocation(forge, input.remoteUrl, input.forgeWeb);
  const branch = input.branch?.trim();
  if (!grammar || !location || !branch || branch === "HEAD") {
    return null;
  }
  return `${forgeOrigin(location)}/${location.repo}${grammar.treeInfix}${encodeBranch(branch)}`;
}

export function buildForgeBlobUrl(forge: string, input: ForgeBlobUrlInput): string | null {
  const grammar = getClientForgeLogicModule(forge)?.urlGrammar;
  const location = resolveForgeWebLocation(forge, input.remoteUrl, input.forgeWeb);
  const branch = input.branch?.trim();
  const filePath = normalizeBlobPath(input.path);
  if (!grammar || !location || !branch || branch === "HEAD" || !filePath) {
    return null;
  }
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  let url = `${forgeOrigin(location)}/${location.repo}${grammar.blobInfix}${encodeBranch(branch)}/${encodedPath}`;
  if (input.lineStart && input.lineStart > 0) {
    url += grammar.lineAnchor(input.lineStart, input.lineEnd);
  }
  return url;
}

/**
 * Web URL of a shorthand reference such as `#12` or `group/project!12`. A
 * cross-repository reference stays on the remote's host. Null when the forge
 * has no shorthand for the sigil.
 */
export function buildForgeReferenceUrl(
  forge: string,
  input: ForgeReferenceUrlInput,
): string | null {
  const referencePath = getClientForgeLogicModule(forge)?.urlGrammar?.referencePaths?.find(
    (path) => path.sigil === input.sigil,
  );
  const location = resolveForgeWebLocation(forge, input.remoteUrl, input.forgeWeb);
  const repo = input.repo ?? input.forgeWeb?.referenceRepository ?? location?.repo;
  if (
    !referencePath ||
    !location ||
    !repo ||
    !isValidRepoPath(repo) ||
    !Number.isSafeInteger(input.number) ||
    input.number <= 0
  ) {
    return null;
  }
  return `${forgeOrigin(location)}/${repo}${referencePath.infix}${input.number}`;
}

/** Whether the forge has web URL builders (i.e. a known URL grammar). */
export function hasForgeWebUrls(forge: string): boolean {
  return getClientForgeLogicModule(forge)?.urlGrammar !== undefined;
}
