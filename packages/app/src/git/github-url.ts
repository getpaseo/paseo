import { parseGitHubRemoteUrl } from "@server/shared/git-remote";

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
