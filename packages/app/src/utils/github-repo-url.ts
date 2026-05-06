// TODO: this duplicates parseGitHubRepoFromRemote in packages/server/src/services/github-service.ts.
// Consolidate into a shared package once we have a third caller.

// Note: SSH host aliases (e.g. `git@github-work:acme/repo.git` resolved via ~/.ssh/config)
// are not detected here, so the GitHub action will silently not appear for those remotes.
export function parseGitHubRepoFromRemote(remoteUrl: string | null | undefined): string | null {
  const trimmed = remoteUrl?.trim();
  if (!trimmed) {
    return null;
  }

  let cleaned = trimmed;
  if (cleaned.startsWith("git@github.com:")) {
    cleaned = cleaned.slice("git@github.com:".length);
  } else {
    let parsed: URL;
    try {
      parsed = new URL(cleaned);
    } catch {
      return null;
    }
    if (parsed.hostname !== "github.com") {
      return null;
    }
    try {
      cleaned = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    } catch {
      return null;
    }
  }

  cleaned = cleaned.replace(/\/+$/, "");
  if (cleaned.endsWith(".git")) {
    cleaned = cleaned.slice(0, -".git".length);
  }
  if (!cleaned.includes("/")) {
    return null;
  }
  return cleaned;
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
