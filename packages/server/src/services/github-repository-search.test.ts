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
          isPrivate: false,
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
          "id,name,nameWithOwner,description,isPrivate,updatedAt,sshUrl,url",
          "--limit",
          "8",
        ],
        options: { cwd: "/tmp", executablePath: "/usr/bin/gh" },
      },
      {
        args: ["config", "get", "git_protocol", "--host", "github.com"],
        options: { cwd: "/tmp", executablePath: "/usr/bin/gh" },
      },
    ]);
  });

  it("respects an explicit visibility qualifier and normalizes the search result", async () => {
    const runner = createRunner([
      JSON.stringify([
        {
          id: 42,
          name: "private-repo",
          fullName: "octo/private-repo",
          description: "Private project",
          isPrivate: true,
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
      service.searchRepositories({ cwd: "/tmp", query: " is:private private project ", limit: 5 }),
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
          "is:private private project",
          "--json",
          "id,name,fullName,description,isPrivate,updatedAt,url",
          "--limit",
          "5",
          "--sort",
          "updated",
          "--order",
          "desc",
        ],
        options: { cwd: "/tmp", executablePath: "/usr/bin/gh" },
      },
      {
        args: ["config", "get", "git_protocol", "--host", "github.com"],
        options: { cwd: "/tmp", executablePath: "/usr/bin/gh" },
      },
    ]);
  });

  it("puts private matches first even when the general search omits some of them", async () => {
    const repository = (id: number, fullName: string, isPrivate: boolean) => ({
      id,
      name: fullName.split("/")[1],
      fullName,
      description: "An editor",
      isPrivate,
      updatedAt: "2026-07-14T08:00:00Z",
      url: `https://github.com/${fullName}`,
    });
    const privateEditor = repository(1, "example/editor", true);
    const publicEditor = repository(2, "public/recent-editor", false);
    const anotherPublicEditor = repository(3, "public/another-editor", false);
    const recentPrivateEditor = repository(4, "example/recent-editor", true);
    const service = createGitHubService({
      runner: async (args) => {
        if (args[0] === "config") {
          return { stdout: "https", stderr: "" };
        }
        const results = args.includes("--visibility=private")
          ? [privateEditor, recentPrivateEditor]
          : [publicEditor, recentPrivateEditor, anotherPublicEditor];
        return { stdout: JSON.stringify(results), stderr: "" };
      },
      resolveGhPath: async () => "/usr/bin/gh",
    });

    const results = await service.searchRepositories({ cwd: "/tmp", query: "editor", limit: 3 });
    expect(results.map((result) => result.nameWithOwner)).toEqual([
      "example/editor",
      "example/recent-editor",
      "public/recent-editor",
    ]);
  });
});
