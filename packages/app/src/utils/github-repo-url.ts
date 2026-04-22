function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parseGitHubRepoFromRemote(remoteUrl: string | null | undefined): string | null {
  const normalizedRemote = trimNonEmpty(remoteUrl);
  if (!normalizedRemote) {
    return null;
  }

  let cleaned = normalizedRemote;
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
  const branch = trimNonEmpty(input.branch);
  if (!repo || !branch || branch === "HEAD") {
    return null;
  }

  const encodedBranch = branch.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${repo}/tree/${encodedBranch}`;
}
