import { describe, expect, it } from "vitest";
import {
  GitHubAuthenticationError,
  GitHubCliMissingError,
  GitHubCommandError,
  createGitHubService,
  type GitHubCommandRunner,
  type GitHubCommandRunnerOptions,
} from "./github-service.js";

interface RunnerCall {
  args: string[];
  cwd: string;
}

interface TestRunner {
  calls: RunnerCall[];
  runner: GitHubCommandRunner;
  resolveNext: (stdout: string) => void;
}

function createRunner(stdoutByCall: string[]): TestRunner {
  const calls: RunnerCall[] = [];

  return {
    calls,
    runner: async (args: string[], options: GitHubCommandRunnerOptions) => {
      calls.push({ args, cwd: options.cwd });
      const stdout = stdoutByCall.shift() ?? "[]";
      return { stdout, stderr: "" };
    },
    resolveNext: () => {},
  };
}

function createDeferredRunner(): TestRunner {
  const calls: RunnerCall[] = [];
  let resolveNext: ((stdout: string) => void) | null = null;

  return {
    calls,
    runner: (args: string[], options: GitHubCommandRunnerOptions) => {
      calls.push({ args, cwd: options.cwd });
      return new Promise((resolve) => {
        resolveNext = (stdout: string) => resolve({ stdout, stderr: "" });
      });
    },
    resolveNext: (stdout: string) => {
      if (!resolveNext) {
        throw new Error("No runner call is waiting for resolution.");
      }
      resolveNext(stdout);
    },
  };
}

function pullRequestJson(title: string): string {
  return JSON.stringify([
    {
      number: 123,
      title,
      url: "https://github.com/acme/repo/pull/123",
      state: "OPEN",
      baseRefName: "main",
      headRefName: "feature",
      labels: [{ name: "bug" }],
    },
  ]);
}

describe("GitHubService", () => {
  it("returns cached results for identical calls within the TTL", async () => {
    const runner = createRunner([pullRequestJson("First result")]);
    const service = createGitHubService({
      ttlMs: 1_000,
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });

    const first = await service.listPullRequests({ cwd: "/repo", query: "bug", limit: 10 });
    const second = await service.listPullRequests({ cwd: "/repo", query: "bug", limit: 10 });

    expect(first).toEqual(second);
    expect(first[0]?.title).toBe("First result");
    expect(runner.calls).toHaveLength(1);
  });

  it("refreshes cached results after the TTL expires", async () => {
    let now = 100;
    const runner = createRunner([
      pullRequestJson("First result"),
      pullRequestJson("Second result"),
    ]);
    const service = createGitHubService({
      ttlMs: 50,
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => now,
    });

    const first = await service.listPullRequests({ cwd: "/repo", query: "bug", limit: 10 });
    now = 151;
    const second = await service.listPullRequests({ cwd: "/repo", query: "bug", limit: 10 });

    expect(first[0]?.title).toBe("First result");
    expect(second[0]?.title).toBe("Second result");
    expect(runner.calls).toHaveLength(2);
  });

  it("coalesces concurrent identical calls into one runner invocation", async () => {
    const runner = createDeferredRunner();
    const service = createGitHubService({
      ttlMs: 1_000,
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });

    const first = service.listPullRequests({ cwd: "/repo", query: "bug", limit: 10 });
    const second = service.listPullRequests({ cwd: "/repo", query: "bug", limit: 10 });
    await Promise.resolve();
    runner.resolveNext(pullRequestJson("Shared result"));

    await expect(Promise.all([first, second])).resolves.toEqual([
      [
        {
          number: 123,
          title: "Shared result",
          url: "https://github.com/acme/repo/pull/123",
          state: "OPEN",
          body: null,
          baseRefName: "main",
          headRefName: "feature",
          labels: ["bug"],
        },
      ],
      [
        {
          number: 123,
          title: "Shared result",
          url: "https://github.com/acme/repo/pull/123",
          state: "OPEN",
          body: null,
          baseRefName: "main",
          headRefName: "feature",
          labels: ["bug"],
        },
      ],
    ]);
    expect(runner.calls).toHaveLength(1);
  });

  it("invalidates only cache entries matching the requested cwd", async () => {
    const runner = createRunner([
      pullRequestJson("Repo one"),
      pullRequestJson("Repo two"),
      pullRequestJson("Repo one refreshed"),
    ]);
    const service = createGitHubService({
      ttlMs: 1_000,
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });

    await service.listPullRequests({ cwd: "/repo-one", query: "bug", limit: 10 });
    await service.listPullRequests({ cwd: "/repo-two", query: "bug", limit: 10 });
    service.invalidate({ cwd: "/repo-one" });
    const refreshed = await service.listPullRequests({ cwd: "/repo-one", query: "bug", limit: 10 });
    const cached = await service.listPullRequests({ cwd: "/repo-two", query: "bug", limit: 10 });

    expect(refreshed[0]?.title).toBe("Repo one refreshed");
    expect(cached[0]?.title).toBe("Repo two");
    expect(runner.calls).toHaveLength(3);
  });

  it("throws a typed missing-cli error when gh is unavailable", async () => {
    const runner = createRunner([]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => null,
      now: () => 100,
    });

    await expect(service.listPullRequests({ cwd: "/repo" })).rejects.toBeInstanceOf(
      GitHubCliMissingError,
    );
    expect(runner.calls).toHaveLength(0);
  });

  it("throws a typed auth error for authentication failures", async () => {
    const service = createGitHubService({
      runner: async () => {
        throw new GitHubCommandError({
          args: ["auth", "status"],
          cwd: "/repo",
          exitCode: 1,
          stderr: "To authenticate, run: gh auth login",
        });
      },
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });

    await expect(service.isAuthenticated({ cwd: "/repo" })).rejects.toBeInstanceOf(
      GitHubAuthenticationError,
    );
  });

  it("throws a typed command error for non-zero exits", async () => {
    const service = createGitHubService({
      runner: async () => {
        throw new GitHubCommandError({
          args: ["pr", "list"],
          cwd: "/repo",
          exitCode: 2,
          stderr: "GraphQL: unavailable",
        });
      },
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });

    await expect(service.listPullRequests({ cwd: "/repo" })).rejects.toMatchObject({
      kind: "command-error",
      exitCode: 2,
      stderr: "GraphQL: unavailable",
    });
  });
});
