import { describe, expect, it } from "vitest";
import type { GitCommandOptions, GitCommandResult } from "./run-git-command.js";
import {
  fetchBaseRefFromRemote,
  preferFastForwardedRemoteRef,
  resolveBaseRefFetchTarget,
} from "./fetch-base-ref.js";

function recordingGit(behaviour: (args: string[]) => GitCommandResult | Error) {
  const calls: string[][] = [];
  const run = async (args: string[], _options: GitCommandOptions): Promise<GitCommandResult> => {
    calls.push(args);
    const outcome = behaviour(args);
    if (outcome instanceof Error) {
      throw outcome;
    }
    return outcome;
  };
  return { calls, run };
}

function gitOutput(stdout: string): GitCommandResult {
  return { stdout, stderr: "", truncated: false, exitCode: 0, signal: null };
}

// A configured remote plus a fetch that succeeds.
function healthyRemote() {
  return recordingGit((args) =>
    args[0] === "config" ? gitOutput("git@github.com:acme/app.git\n") : gitOutput(""),
  );
}

describe("resolveBaseRefFetchTarget", () => {
  it("reads the remote from a qualified remote-tracking ref so forks fetch their upstream", () => {
    expect(resolveBaseRefFetchTarget("refs/remotes/upstream/main")).toEqual({
      remote: "upstream",
      branch: "main",
    });
  });

  it("keeps slashes in the branch when splitting a remote-tracking ref", () => {
    expect(resolveBaseRefFetchTarget("refs/remotes/origin/release/2026-08")).toEqual({
      remote: "origin",
      branch: "release/2026-08",
    });
  });

  it.each([
    ["origin/main", "main"],
    ["refs/heads/main", "main"],
    ["main", "main"],
    ["feature/nested/name", "feature/nested/name"],
  ])("falls back to origin for %s", (input, branch) => {
    expect(resolveBaseRefFetchTarget(input)).toEqual({ remote: "origin", branch });
  });

  it("returns null when there is no branch to fetch", () => {
    expect(resolveBaseRefFetchTarget("   ")).toBeNull();
    expect(resolveBaseRefFetchTarget("refs/remotes/origin")).toBeNull();
    expect(resolveBaseRefFetchTarget("refs/remotes/origin/")).toBeNull();
  });
});

describe("fetchBaseRefFromRemote", () => {
  it("fetches exactly one branch, never a pruning or repository-wide refspec", async () => {
    const git = healthyRemote();

    await expect(fetchBaseRefFromRemote("/repo", "refs/heads/main", git.run)).resolves.toBe(true);

    expect(git.calls).toContainEqual(["fetch", "origin", "main"]);
    const fetchArgs = git.calls.filter((args) => args[0] === "fetch");
    expect(fetchArgs).toHaveLength(1);
    expect(fetchArgs[0]).not.toContain("--prune");
    expect(fetchArgs[0]).not.toContain("--all");
  });

  it("fetches from the remote named by the base ref", async () => {
    const git = healthyRemote();

    await fetchBaseRefFromRemote("/repo", "refs/remotes/upstream/main", git.run);

    expect(git.calls).toContainEqual(["config", "--get", "remote.upstream.url"]);
    expect(git.calls).toContainEqual(["fetch", "upstream", "main"]);
  });

  it("skips the fetch when the remote is not configured", async () => {
    const git = recordingGit((args) =>
      args[0] === "config" ? gitOutput("") : new Error("should not run"),
    );

    await expect(fetchBaseRefFromRemote("/repo", "main", git.run)).resolves.toBe(false);

    expect(git.calls.some((args) => args[0] === "fetch")).toBe(false);
  });

  it("reports failure instead of throwing when the remote is unreachable", async () => {
    const git = recordingGit((args) =>
      args[0] === "config"
        ? gitOutput("git@github.com:acme/app.git\n")
        : new Error("could not resolve host"),
    );

    await expect(fetchBaseRefFromRemote("/repo", "main", git.run)).resolves.toBe(false);
  });

  it("does nothing when the base ref names no branch", async () => {
    const git = recordingGit(() => new Error("should not run"));

    await expect(fetchBaseRefFromRemote("/repo", "  ", git.run)).resolves.toBe(false);

    expect(git.calls).toEqual([]);
  });
});

describe("preferFastForwardedRemoteRef", () => {
  // `git rev-list --left-right --count local...remote` prints "<local-only> <remote-only>".
  function revListGit(counts: string) {
    return recordingGit((args) =>
      args[0] === "rev-list" ? gitOutput(`${counts}\n`) : new Error("unexpected"),
    );
  }

  it("takes the remote tip when the local branch is purely behind it", async () => {
    await expect(
      preferFastForwardedRemoteRef("/repo", "main", revListGit("0\t3").run),
    ).resolves.toBe("refs/remotes/origin/main");
  });

  it("keeps the local branch when it holds commits the remote does not", async () => {
    await expect(
      preferFastForwardedRemoteRef("/repo", "main", revListGit("2\t3").run),
    ).resolves.toBeNull();
    await expect(
      preferFastForwardedRemoteRef("/repo", "main", revListGit("2\t0").run),
    ).resolves.toBeNull();
  });

  it("keeps the local branch when the two are level", async () => {
    await expect(
      preferFastForwardedRemoteRef("/repo", "main", revListGit("0\t0").run),
    ).resolves.toBeNull();
  });

  it.each(["refs/remotes/origin/main", "origin/main", "refs/remotes/upstream/main"])(
    "never second-guesses the explicitly qualified ref %s",
    async (baseRef) => {
      const git = recordingGit(() => new Error("should not run"));

      await expect(preferFastForwardedRemoteRef("/repo", baseRef, git.run)).resolves.toBeNull();

      expect(git.calls).toEqual([]);
    },
  );

  it("keeps the local branch when the refs cannot be compared", async () => {
    const git = recordingGit(() => new Error("unknown revision"));

    await expect(preferFastForwardedRemoteRef("/repo", "local-only", git.run)).resolves.toBeNull();
  });
});
