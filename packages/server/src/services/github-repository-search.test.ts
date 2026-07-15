import { describe, expect, it } from "vitest";
import {
  createGitHubService,
  type GitHubCommandRunner,
  type GitHubCommandRunnerOptions,
} from "./github-service.js";

interface RunnerCall {
  args: string[];
  options: GitHubCommandRunnerOptions;
}

function createRunner(outputs: string[]): { calls: RunnerCall[]; runner: GitHubCommandRunner } {
  const calls: RunnerCall[] = [];
  return {
    calls,
    runner: async (args, options) => {
      calls.push({ args, options });
      return { stdout: outputs.shift() ?? "", stderr: "" };
    },
  };
}

describe("GitHub repository search", () => {
  it("lists recent owned repositories for an empty query and normalizes clone identity", async () => {
    const runner = createRunner([
      JSON.stringify([
        {
          id: " R_recent ",
          name: " paseo ",
          nameWithOwner: " getpaseo/paseo ",
          description: null,
          visibility: "PUBLIC",
          updatedAt: "2026-07-15T12:00:00Z",
          sshUrl: " git@github.com:getpaseo/paseo.git ",
          url: "https://github.com/getpaseo/paseo",
        },
      ]),
      "ssh\n",
    ]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
    });

    await expect(
      service.searchRepositories({ cwd: "/tmp", query: "  ", limit: 8 }),
    ).resolves.toEqual([
      {
        id: "R_recent",
        name: "paseo",
        nameWithOwner: "getpaseo/paseo",
        description: null,
        visibility: "public",
        updatedAt: "2026-07-15T12:00:00Z",
        cloneUrl: "git@github.com:getpaseo/paseo.git",
      },
    ]);
    expect(runner.calls).toEqual([
      {
        args: [
          "repo",
          "list",
          "--json",
          "id,name,nameWithOwner,description,visibility,updatedAt,sshUrl,url",
          "--limit",
          "8",
        ],
        options: { cwd: "/tmp" },
      },
      {
        args: ["config", "get", "git_protocol", "--host", "github.com"],
        options: { cwd: "/tmp" },
      },
    ]);
  });

  it("searches accessible repositories for a typed query", async () => {
    const runner = createRunner([
      JSON.stringify([
        {
          id: 42,
          name: "private-repo",
          fullName: "octo/private-repo",
          description: "Private project",
          visibility: "PRIVATE",
          updatedAt: "2026-07-14T08:00:00Z",
          url: "https://github.com/octo/private-repo",
        },
      ]),
      "https",
    ]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
    });

    await expect(
      service.searchRepositories({ cwd: "/tmp", query: " private project ", limit: 5 }),
    ).resolves.toEqual([
      {
        id: "42",
        name: "private-repo",
        nameWithOwner: "octo/private-repo",
        description: "Private project",
        visibility: "private",
        updatedAt: "2026-07-14T08:00:00Z",
        cloneUrl: "https://github.com/octo/private-repo",
      },
    ]);
    expect(runner.calls).toEqual([
      {
        args: [
          "search",
          "repos",
          "private project",
          "--json",
          "id,name,fullName,description,visibility,updatedAt,url",
          "--sort",
          "updated",
          "--order",
          "desc",
          "--limit",
          "5",
        ],
        options: { cwd: "/tmp" },
      },
      {
        args: ["config", "get", "git_protocol", "--host", "github.com"],
        options: { cwd: "/tmp" },
      },
    ]);
  });
});
