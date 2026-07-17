/**
 * Forge-neutral web URL builders for "Open on <forge>" actions (a file blob or a
 * branch tree). The host comes from the workspace remote — not a hardcoded
 * cloud host — so self-hosted and Enterprise instances link correctly. Each
 * forge contributes a small URL grammar (the path infixes and line-anchor
 * format); an unknown forge has no grammar and yields null, so the action is
 * simply absent rather than wrong.
 *
 * URL grammar lives on each client forge module. The repo identity and host
 * both ride the manifest's `cloudHosts` only to canonicalize a cloud SSH alias
 * (e.g. ssh.github.com -> github.com); a self-hosted host is used as-is.
 */
import { getForgeDefinition } from "@getpaseo/protocol/forge-manifest";
import { normalizeHost, parseGitRemoteLocation } from "@getpaseo/protocol/git-remote";
import { getClientForgeLogicModule } from "@/git/forges";

export interface ForgeBlobUrlInput {
  remoteUrl: string | null | undefined;
  branch: string | null | undefined;
  path: string | null | undefined;
  lineStart?: number;
  lineEnd?: number;
}

export interface ForgeBranchTreeUrlInput {
  remoteUrl: string | null | undefined;
  branch: string | null | undefined;
}

interface ForgeWebLocation {
  host: string;
  repo: string;
}

/**
 * Web host + repo path from a remote. The host is the remote's host, except a
 * cloud SSH alias (a non-first entry in the forge's `cloudHosts`, e.g.
 * ssh.github.com) is canonicalized to the forge's web host (`cloudHosts[0]`).
 * Self-hosted hosts are returned untouched. The repo path supports nested
 * groups (e.g. GitLab subgroups) since it is the full remote path.
 */
function isValidRepoPath(path: string): boolean {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return false;
  }
  return !segments.includes("..");
}

function resolveForgeWebLocation(
  forge: string,
  remoteUrl: string | null | undefined,
): ForgeWebLocation | null {
  if (!remoteUrl) {
    return null;
  }
  const location = parseGitRemoteLocation(remoteUrl);
  if (!location || !isValidRepoPath(location.path)) {
    return null;
  }
  const cloudHosts = getForgeDefinition(forge)?.cloudHosts;
  const webHost =
    cloudHosts && cloudHosts.length > 0 && cloudHosts.map(normalizeHost).includes(location.host)
      ? normalizeHost(cloudHosts[0])
      : location.host;
  return { host: webHost, repo: location.path };
}

function encodeBranch(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
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
  const location = resolveForgeWebLocation(forge, input.remoteUrl);
  const branch = input.branch?.trim();
  if (!grammar || !location || !branch || branch === "HEAD") {
    return null;
  }
  return `https://${location.host}/${location.repo}${grammar.treeInfix}${encodeBranch(branch)}`;
}

export function buildForgeBlobUrl(forge: string, input: ForgeBlobUrlInput): string | null {
  const grammar = getClientForgeLogicModule(forge)?.urlGrammar;
  const location = resolveForgeWebLocation(forge, input.remoteUrl);
  const branch = input.branch?.trim();
  const filePath = normalizeBlobPath(input.path);
  if (!grammar || !location || !branch || branch === "HEAD" || !filePath) {
    return null;
  }
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  let url = `https://${location.host}/${location.repo}${grammar.blobInfix}${encodeBranch(branch)}/${encodedPath}`;
  if (input.lineStart && input.lineStart > 0) {
    url += grammar.lineAnchor(input.lineStart, input.lineEnd);
  }
  return url;
}

/** Whether the forge has web URL builders (i.e. a known URL grammar). */
export function hasForgeWebUrls(forge: string): boolean {
  return getClientForgeLogicModule(forge)?.urlGrammar !== undefined;
}
