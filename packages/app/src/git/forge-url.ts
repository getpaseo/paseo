/**
 * Forge-neutral web URL builders for "Open on <forge>" actions (a file blob or a
 * branch tree). The host comes from the workspace remote — not a hardcoded
 * cloud host — so self-hosted and Enterprise instances link correctly. Each
 * forge contributes a small URL grammar (the path infixes and line-anchor
 * format); an unknown forge has no grammar and yields null, so the action is
 * simply absent rather than wrong.
 *
 * URL grammar lives on each client forge module. The repo identity and host use
 * manifest metadata only to map known aliases or custom web origins; an
 * unconfigured self-hosted host is used as-is.
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
  /** Non-default port for a self-hosted http(s) origin, or undefined. */
  port?: string;
  repo: string;
}

/**
 * Web host + repo path from a remote. Manifest overrides map hosts with custom
 * browser origins; cloud SSH aliases otherwise use the forge's primary host.
 * The repo path supports nested groups since it is the full remote path.
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
  const definition = getForgeDefinition(forge);
  const cloudHosts = (definition?.cloudHosts ?? []).map(normalizeHost);
  const isCloudHost = cloudHosts.includes(location.host);
  const configuredAuthority = definition?.webAuthorities?.[location.host];
  const [configuredHost, configuredPort] = configuredAuthority?.split(":") ?? [];
  const webHost = configuredHost ?? (isCloudHost ? cloudHosts[0] : location.host);
  // Without an explicit web authority, only an http(s) remote can supply the
  // browser port. An SSH remote's port is unrelated to the web origin.
  const port =
    configuredPort ??
    (!isCloudHost && (location.transport === "http" || location.transport === "https")
      ? location.port
      : undefined);
  return { host: webHost, port, repo: location.path };
}

function encodeBranch(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

/** Host, plus `:port` when the remote pins a non-default port. */
function forgeAuthority(location: ForgeWebLocation): string {
  return location.port ? `${location.host}:${location.port}` : location.host;
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
  return `https://${forgeAuthority(location)}/${location.repo}${grammar.treeInfix}${encodeBranch(branch)}`;
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
  let url = `https://${forgeAuthority(location)}/${location.repo}${grammar.blobInfix}${encodeBranch(branch)}/${encodedPath}`;
  if (input.lineStart && input.lineStart > 0) {
    url += grammar.lineAnchor(input.lineStart, input.lineEnd);
  }
  return url;
}

/** Whether the forge has web URL builders (i.e. a known URL grammar). */
export function hasForgeWebUrls(forge: string): boolean {
  return getClientForgeLogicModule(forge)?.urlGrammar !== undefined;
}
