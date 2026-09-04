import { describe, expect, it } from "vitest";
import {
  deriveProjectDisplayName,
  deriveProjectKey,
  deriveRemoteProjectKey,
  groupAgents,
} from "./agent-grouping";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";

function makePlacement(projectKey: string): AggregatedAgent["projectPlacement"] {
  return {
    projectKey,
    projectName: "paseo",
    workspaceName: null,
    checkout: {
      cwd: "/Users/me/dev/paseo",
      isGit: false,
      currentBranch: null,
      remoteUrl: null,
      worktreeRoot: null,
      isPaseoOwnedWorktree: false,
      mainRepoRoot: null,
    },
  };
}

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
    projectPlacement: overrides.projectPlacement,
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

  it("groups worktree agents by the daemon's project placement", () => {
    const placement = makePlacement("remote:github.com/getpaseo/paseo");
    const agents = [
      makeAgent({ id: "a1", cwd: "/Users/me/dev/paseo", projectPlacement: placement }),
      makeAgent({
        id: "a2",
        cwd: "/mnt/scratch/trees/a1b2c3d4/brave-otter",
        projectPlacement: placement,
      }),
    ];

    const { activeGroups } = groupAgents(agents, { getRemoteUrl: () => null });

    expect(activeGroups).toHaveLength(1);
    expect(activeGroups[0]?.projectKey).toBe("remote:github.com/getpaseo/paseo");
  });
});

describe("deriveProjectKey", () => {
  it("groups sibling agents of one worktree under a custom worktrees root", () => {
    const worktreesRoot = "/mnt/scratch/trees";
    expect(
      deriveProjectKey("/mnt/scratch/trees/a1b2c3d4/brave-otter/packages/app", worktreesRoot),
    ).toBe("/mnt/scratch/trees/a1b2c3d4/brave-otter");
  });

  it("separates worktrees cut from different repos", () => {
    const worktreesRoot = "/mnt/scratch/trees";
    expect(deriveProjectKey("/mnt/scratch/trees/a1b2c3d4/one", worktreesRoot)).not.toBe(
      deriveProjectKey("/mnt/scratch/trees/e5f6a7b8/two", worktreesRoot),
    );
  });

  it("returns the cwd for ordinary checkouts", () => {
    expect(deriveProjectKey("/Users/me/dev/paseo", "/mnt/scratch/trees")).toBe(
      "/Users/me/dev/paseo",
    );
  });

  // COMPAT(worktreesRoot): drop once the daemon floor reports worktreesRoot.
  it("recovers the parent repo from the legacy layout when no root is reported", () => {
    expect(deriveProjectKey("/Users/me/repo/.paseo/worktrees/feature")).toBe("/Users/me/repo");
  });
});
