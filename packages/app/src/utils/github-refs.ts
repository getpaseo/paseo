import { parseGitHubRemoteUrl } from "@getpaseo/protocol/git-remote";

export type GithubRefKind = "pull" | "issues";

export interface GithubRemote {
  owner: string;
  repo: string;
  host: "github.com";
}

export interface GithubRef {
  kind: GithubRefKind;
  number: number;
  owner: string;
  repo: string;
  url: string;
}

interface ParsedGithubUrl {
  kind: GithubRefKind;
  number: number;
  owner: string;
  repo: string;
}

const GITHUB_REF_URL_PATTERN =
  /https?:\/\/github\.com\/([^/\s<>)\]]+)\/([^/\s<>)\]]+)\/(pull|issues)\/(\d+)(?:[/?#][^\s<>)\]]*)?/giu;

export function normalizeGithubRemote(remoteUrl: string | null | undefined): GithubRemote | null {
  const trimmed = remoteUrl?.trim();
  if (!trimmed) {
    return null;
  }

  const identity = parseGitHubRemoteUrl(trimmed);
  if (!identity) {
    return null;
  }

  return {
    owner: identity.owner,
    repo: identity.name,
    host: "github.com",
  };
}

export function parseGithubRef(
  text: string | null | undefined,
  remoteUrl: string | null | undefined,
): GithubRef | null {
  return extractGithubRefs(text, remoteUrl)[0] ?? null;
}

export function extractGithubRefs(
  text: string | null | undefined,
  remoteUrl: string | null | undefined,
): GithubRef[] {
  const remote = normalizeGithubRemote(remoteUrl);
  const body = text?.trim();
  if (!remote || !body) {
    return [];
  }

  const refs: GithubRef[] = [];
  const seen = new Set<string>();

  for (const match of body.matchAll(GITHUB_REF_URL_PATTERN)) {
    const parsed = parseGithubUrlMatch(match);
    if (!parsed || !matchesRemote(parsed, remote)) {
      continue;
    }

    const dedupeKey = `${parsed.kind}:${parsed.number}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);

    refs.push({
      kind: parsed.kind,
      number: parsed.number,
      owner: remote.owner,
      repo: remote.repo,
      url: `https://github.com/${remote.owner}/${remote.repo}/${parsed.kind}/${parsed.number}`,
    });
  }

  return refs;
}

function parseGithubUrlMatch(match: RegExpMatchArray): ParsedGithubUrl | null {
  const owner = match[1];
  const repo = match[2];
  const kind = match[3];
  const numberText = match[4];
  if (!owner || !repo || !isGithubRefKind(kind) || !numberText) {
    return null;
  }

  const number = Number.parseInt(numberText, 10);
  if (!Number.isSafeInteger(number) || number <= 0) {
    return null;
  }

  return { owner, repo, kind, number };
}

function isGithubRefKind(value: string): value is GithubRefKind {
  return value === "pull" || value === "issues";
}

function matchesRemote(parsed: ParsedGithubUrl, remote: GithubRemote): boolean {
  return (
    parsed.owner.toLowerCase() === remote.owner.toLowerCase() &&
    parsed.repo.toLowerCase() === remote.repo.toLowerCase()
  );
}
