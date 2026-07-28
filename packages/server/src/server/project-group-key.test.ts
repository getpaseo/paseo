import path from "node:path";
import { describe, expect, test } from "vitest";
import { deriveProjectGroupKey } from "./project-group-key.js";

describe("deriveProjectGroupKey", () => {
  test("preserves an explicit remote port", () => {
    const rootPath = path.resolve("repo");

    expect(
      deriveProjectGroupKey({
        rootPath,
        remoteUrl: "https://git.example.com:8443/acme/app.git",
        worktreeRoot: rootPath,
        mainRepoRoot: null,
      }),
    ).toBe("remote:git.example.com:8443/acme/app");
  });

  test("accepts a root-level remote repository path", () => {
    const rootPath = path.resolve("repo");

    expect(
      deriveProjectGroupKey({
        rootPath,
        remoteUrl: "https://git.example.com/repo.git",
        worktreeRoot: rootPath,
        mainRepoRoot: null,
      }),
    ).toBe("remote:git.example.com/repo");
  });

  test("accepts an SCP-style remote without a username", () => {
    const rootPath = path.resolve("repo");

    expect(
      deriveProjectGroupKey({
        rootPath,
        remoteUrl: "github.com:getpaseo/paseo.git",
        worktreeRoot: rootPath,
        mainRepoRoot: null,
      }),
    ).toBe("remote:github.com/getpaseo/paseo");
  });

  test("includes the selected path within a repository", () => {
    const worktreeRoot = path.resolve("repo");
    const rootPath = path.join(worktreeRoot, "packages", "app");

    expect(
      deriveProjectGroupKey({
        rootPath,
        remoteUrl: "git@github.com:getpaseo/paseo.git",
        worktreeRoot,
        mainRepoRoot: null,
      }),
    ).toBe("remote:github.com/getpaseo/paseo#subdir:packages/app");
  });

  test("keeps repository-root keys stable", () => {
    const rootPath = path.resolve("repo");

    expect(
      deriveProjectGroupKey({
        rootPath,
        remoteUrl: "git@github.com:getpaseo/paseo.git",
        worktreeRoot: rootPath,
        mainRepoRoot: null,
      }),
    ).toBe("remote:github.com/getpaseo/paseo");
  });

  test("preserves the selected path for a checkout without a remote", () => {
    const worktreeRoot = path.resolve("worktree");
    const mainRepoRoot = path.resolve("main");

    expect(
      deriveProjectGroupKey({
        rootPath: path.join(worktreeRoot, "packages", "app"),
        remoteUrl: null,
        worktreeRoot,
        mainRepoRoot,
      }),
    ).toBe(path.join(mainRepoRoot, "packages", "app"));
  });
});
