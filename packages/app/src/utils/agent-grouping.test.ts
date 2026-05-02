import { describe, expect, it } from "vitest";
import {
  deriveProjectDisplayName,
  deriveProjectKey,
  deriveProjectName,
  deriveRemoteProjectKey,
  groupAgents,
  parseRepoNameFromRemoteUrl,
  parseRepoShortNameFromRemoteUrl,
} from "./agent-grouping";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";

function makeAgent(overrides: Partial<AggregatedAgent> = {}): AggregatedAgent {
  const now = new Date();
  return {
    id: overrides.id ?? "a1",
    serverId: overrides.serverId ?? "s1",
    serverLabel: (overrides as { serverLabel?: string }).serverLabel ?? "server",
    title: overrides.title ?? null,
    status: overrides.status ?? ("running" as AggregatedAgent["status"]),
    lastActivityAt: overrides.lastActivityAt ?? now,
    cwd: overrides.cwd ?? "/tmp/repo",
    provider: overrides.provider ?? ("openai" as AggregatedAgent["provider"]),
    requiresAttention: overrides.requiresAttention ?? false,
    attentionReason: overrides.attentionReason ?? null,
    attentionTimestamp: overrides.attentionTimestamp ?? null,
  } as AggregatedAgent;
}

describe("deriveRemoteProjectKey", () => {
  it("normalizes GitHub SSH and HTTPS to the same key", () => {
    const ssh = "git@github.com:owner/repo.git";
    const https = "https://github.com/owner/repo";
    expect(deriveRemoteProjectKey(ssh)).toBe("remote:github.com/owner/repo");
    expect(deriveRemoteProjectKey(https)).toBe("remote:github.com/owner/repo");
  });

  it("includes host for non-GitHub remotes", () => {
    const gitlab = "git@gitlab.example.com:group/repo.git";
    expect(deriveRemoteProjectKey(gitlab)).toBe("remote:gitlab.example.com/group/repo");
  });
});

describe("deriveProjectDisplayName", () => {
  it("shows owner/repo for GitHub remote keys", () => {
    expect(
      deriveProjectDisplayName({
        projectKey: "remote:github.com/getpaseo/paseo",
        projectName: "paseo",
      }),
    ).toBe("getpaseo/paseo");
  });

  it("shows remote path for non-GitHub remote keys", () => {
    expect(
      deriveProjectDisplayName({
        projectKey: "remote:gitlab.example.com/group/repo",
        projectName: "repo",
      }),
    ).toBe("group/repo");
  });

  it("falls back to projectName for local keys", () => {
    expect(
      deriveProjectDisplayName({
        projectKey: "/Users/me/dev/paseo",
        projectName: "paseo",
      }),
    ).toBe("paseo");
  });
});

describe("deriveProjectKey", () => {
  it("returns cwd unchanged for regular paths", () => {
    expect(deriveProjectKey("/Users/me/projects/my-app")).toBe("/Users/me/projects/my-app");
  });

  it("extracts parent repo path from worktree paths", () => {
    expect(deriveProjectKey("/Users/me/repo/.paseo/worktrees/feature-branch")).toBe(
      "/Users/me/repo",
    );
  });

  it("handles worktree path without trailing content", () => {
    expect(deriveProjectKey("/Users/me/repo/.paseo/worktrees/")).toBe("/Users/me/repo");
  });

  it("strips trailing slash from parent repo path", () => {
    expect(deriveProjectKey("/Users/me/repo/.paseo/worktrees/fix")).toBe("/Users/me/repo");
  });

  it("returns simple path unchanged", () => {
    expect(deriveProjectKey("/tmp")).toBe("/tmp");
  });
});

describe("parseRepoNameFromRemoteUrl", () => {
  it("parses SSH URLs", () => {
    expect(parseRepoNameFromRemoteUrl("git@github.com:owner/repo.git")).toBe("owner/repo");
  });

  it("parses SSH URLs without .git suffix", () => {
    expect(parseRepoNameFromRemoteUrl("git@github.com:owner/repo")).toBe("owner/repo");
  });

  it("parses HTTPS URLs", () => {
    expect(parseRepoNameFromRemoteUrl("https://github.com/owner/repo")).toBe("owner/repo");
  });

  it("parses HTTPS URLs with .git suffix", () => {
    expect(parseRepoNameFromRemoteUrl("https://github.com/owner/repo.git")).toBe("owner/repo");
  });

  it("returns null for null input", () => {
    expect(parseRepoNameFromRemoteUrl(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseRepoNameFromRemoteUrl("")).toBeNull();
  });

  it("returns null for URLs without a slash in path", () => {
    expect(parseRepoNameFromRemoteUrl("git@github.com:repo")).toBeNull();
  });
});

describe("parseRepoShortNameFromRemoteUrl", () => {
  it("extracts repo name from SSH URL", () => {
    expect(parseRepoShortNameFromRemoteUrl("git@github.com:owner/my-repo.git")).toBe("my-repo");
  });

  it("extracts repo name from HTTPS URL", () => {
    expect(parseRepoShortNameFromRemoteUrl("https://github.com/owner/my-repo")).toBe("my-repo");
  });

  it("returns null for null input", () => {
    expect(parseRepoShortNameFromRemoteUrl(null)).toBeNull();
  });
});

describe("deriveProjectName", () => {
  it("extracts owner/repo from GitHub remote key", () => {
    expect(deriveProjectName("remote:github.com/owner/repo")).toBe("owner/repo");
  });

  it("extracts last segment from local path", () => {
    expect(deriveProjectName("/Users/me/projects/my-app")).toBe("my-app");
  });

  it("returns the key itself for GitHub remote with no path", () => {
    expect(deriveProjectName("remote:github.com/")).toBe("remote:github.com/");
  });

  it("handles nested paths", () => {
    expect(deriveProjectName("/Users/me/projects/deep/nested/app")).toBe("app");
  });

  it("handles trailing slashes on local paths", () => {
    expect(deriveProjectName("/Users/me/projects/app/")).toBe("app");
  });

  it("handles non-GitHub remote keys", () => {
    expect(deriveProjectName("remote:gitlab.com/group/repo")).toBe("group/repo");
  });
});

describe("groupAgents", () => {
  it("groups active agents by remote URL when available", () => {
    const agents = [
      makeAgent({ id: "a1", cwd: "/Users/me/dev/paseo" }),
      makeAgent({ id: "a2", cwd: "/Users/me/dev/paseo-fix/worktree" }),
    ];

    const { activeGroups } = groupAgents(agents, {
      getRemoteUrl: () => "git@github.com:getpaseo/paseo.git",
    });

    expect(activeGroups).toHaveLength(1);
    expect(activeGroups[0]?.agents.map((a) => a.id).sort()).toEqual(["a1", "a2"]);
  });

  it("falls back to cwd grouping when remote URL is unavailable", () => {
    const agents = [
      makeAgent({ id: "a1", cwd: "/Users/me/dev/paseo" }),
      makeAgent({ id: "a2", cwd: "/Users/me/dev/paseo-fix/worktree" }),
    ];

    const { activeGroups } = groupAgents(agents, {
      getRemoteUrl: () => null,
    });

    expect(activeGroups).toHaveLength(2);
  });
});
