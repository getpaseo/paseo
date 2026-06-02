import { parseGitHubRemoteUrl } from "@getpaseo/protocol/git-remote";

export function parseGitHubRepoFromRemote(remoteUrl: string | null | undefined): string | null {
  const trimmed = remoteUrl?.trim();
  if (!trimmed) {
    return null;
  }
  return parseGitHubRemoteUrl(trimmed)?.repo ?? null;
}

export function buildGitHubBranchTreeUrl(input: {
  remoteUrl: string | null | undefined;
  branch: string | null | undefined;
}): string | null {
  const repo = parseGitHubRepoFromRemote(input.remoteUrl);
  const branch = input.branch?.trim();
  if (!repo || !branch || branch === "HEAD") {
    return null;
  }
  const encodedBranch = branch.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${repo}/tree/${encodedBranch}`;
}

function normalizeGitHubBlobPath(path: string | null | undefined): string | null {
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

export function buildGitHubBlobUrl(input: {
  remoteUrl: string | null | undefined;
  branch: string | null | undefined;
  path: string | null | undefined;
  lineStart?: number;
  lineEnd?: number;
}): string | null {
  const repo = parseGitHubRepoFromRemote(input.remoteUrl);
  const branch = input.branch?.trim();
  const filePath = normalizeGitHubBlobPath(input.path);
  if (!repo || !branch || branch === "HEAD" || !filePath) {
    return null;
  }
  const encodedBranch = branch.split("/").map(encodeURIComponent).join("/");
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  let url = `https://github.com/${repo}/blob/${encodedBranch}/${encodedPath}`;
  if (input.lineStart && input.lineStart > 0) {
    url += `#L${input.lineStart}`;
    if (input.lineEnd && input.lineEnd > input.lineStart) {
      url += `-L${input.lineEnd}`;
    }
  }
  return url;
}
