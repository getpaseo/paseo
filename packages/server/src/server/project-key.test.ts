import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { deriveProjectGroupingDisplayName, deriveProjectKey } from "./project-key.js";

describe("deriveProjectKey", () => {
  const rootPath = path.resolve("repo");
  const derive = (remoteUrl: string) =>
    deriveProjectKey({ rootPath, remoteUrl, worktreeRoot: rootPath, mainRepoRoot: null });

  test.each([
    "https://github.com/getpaseo/paseo.git",
    "ssh://git@github.com/getpaseo/paseo.git",
    "git@github.com:getpaseo/paseo.git",
  ])("normalizes common remote form %s", (remoteUrl) => {
    expect(derive(remoteUrl)).toBe("remote:github.com/getpaseo/paseo");
  });

  test("normalizes GitHub casing", () => {
    expect(derive("git@github.com:GetPaseo/Paseo.git")).toBe("remote:github.com/getpaseo/paseo");
  });

  test("preserves self-hosted paths and explicit ports", () => {
    expect(derive("https://git.example.com:8443/Team/App.git")).toBe(
      "remote:git.example.com:8443/Team/App",
    );
  });

  test("keeps projects without a remote host-local", () => {
    const hostA = deriveProjectKey({
      rootPath,
      remoteUrl: null,
      worktreeRoot: null,
      mainRepoRoot: null,
      serverId: "host-a",
    });
    const hostB = deriveProjectKey({
      rootPath,
      remoteUrl: null,
      worktreeRoot: null,
      mainRepoRoot: null,
      serverId: "host-b",
    });
    expect(hostA).not.toBe(hostB);
  });

  test("uses one host-local key for two spellings of the same directory", () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "project-key-identity-"));
    const projectRoot = path.join(tempRoot, "project");
    const alternateRoot = path.join(tempRoot, "project-alias");
    const deriveLocalProject = (localRootPath: string) =>
      deriveProjectKey({
        rootPath: localRootPath,
        remoteUrl: null,
        worktreeRoot: null,
        mainRepoRoot: null,
        serverId: "host-a",
      });

    try {
      mkdirSync(projectRoot);
      symlinkSync(projectRoot, alternateRoot, process.platform === "win32" ? "junction" : "dir");
      expect(deriveLocalProject(alternateRoot)).toBe(deriveLocalProject(projectRoot));
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("keeps a repository root distinct from one of its subprojects", () => {
    const worktreeRoot = path.resolve("host-a", "repo");
    const remoteUrl = "git@github.com:getpaseo/paseo.git";

    expect(
      deriveProjectKey({ rootPath: worktreeRoot, remoteUrl, worktreeRoot, mainRepoRoot: null }),
    ).toBe("remote:github.com/getpaseo/paseo");
    expect(
      deriveProjectKey({
        rootPath: path.join(worktreeRoot, "packages", "app"),
        remoteUrl,
        worktreeRoot,
        mainRepoRoot: null,
      }),
    ).toBe("remote:github.com/getpaseo/paseo#subdir:packages/app");
  });

  test("groups the same subproject across different absolute checkout roots", () => {
    const remoteUrl = "git@github.com:getpaseo/paseo.git";
    const deriveSubproject = (worktreeRoot: string) =>
      deriveProjectKey({
        rootPath: path.join(worktreeRoot, "packages", "app"),
        remoteUrl,
        worktreeRoot,
        mainRepoRoot: null,
      });

    expect(deriveSubproject(path.resolve("host-a", "repo"))).toBe(
      deriveSubproject(path.resolve("host-b", "different", "repo")),
    );
  });
});

describe("deriveProjectGroupingDisplayName", () => {
  test("uses the owner and repository from a remote", () => {
    expect(
      deriveProjectGroupingDisplayName({
        rootPath: path.resolve("repo"),
        remoteUrl: "git@github.com:getpaseo/paseo.git",
        worktreeRoot: path.resolve("repo"),
      }),
    ).toBe("getpaseo/paseo");
  });

  test("uses the selected directory name without a remote", () => {
    expect(
      deriveProjectGroupingDisplayName({
        rootPath: path.resolve("acme", "app"),
        remoteUrl: null,
        worktreeRoot: null,
      }),
    ).toBe("app");
  });

  test("uses the selected subproject directory name instead of the repository remote", () => {
    const worktreeRoot = path.resolve("acme", "repo");

    expect(
      deriveProjectGroupingDisplayName({
        rootPath: path.join(worktreeRoot, "packages", "server"),
        remoteUrl: "git@github.com:acme/repo.git",
        worktreeRoot,
      }),
    ).toBe("server");
  });
});
