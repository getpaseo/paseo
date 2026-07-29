import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
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

  test("normalizes the default SSH port", () => {
    const rootPath = path.resolve("repo");

    expect(
      deriveProjectGroupKey({
        rootPath,
        remoteUrl: "ssh://git@github.com:22/getpaseo/paseo.git",
        worktreeRoot: rootPath,
        mainRepoRoot: null,
      }),
    ).toBe("remote:github.com/getpaseo/paseo");
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

  test("accepts an SCP-style remote with a bracketed IPv6 host", () => {
    const rootPath = path.resolve("repo");

    expect(
      deriveProjectGroupKey({
        rootPath,
        remoteUrl: "git@[2001:db8::1]:getpaseo/paseo.git",
        worktreeRoot: rootPath,
        mainRepoRoot: null,
      }),
    ).toBe("remote:[2001:db8::1]/getpaseo/paseo");
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

  test("keeps a selected path distinct from remote path syntax", () => {
    const worktreeRoot = path.resolve("repo");
    const selectedKey = deriveProjectGroupKey({
      rootPath: path.join(worktreeRoot, "packages", "app"),
      remoteUrl: "example.com:acme/repo.git",
      worktreeRoot,
      mainRepoRoot: null,
    });
    const remoteSyntaxKey = deriveProjectGroupKey({
      rootPath: worktreeRoot,
      remoteUrl: "example.com:acme/repo#subdir:packages/app.git",
      worktreeRoot,
      mainRepoRoot: null,
    });

    expect(selectedKey).not.toBe(remoteSyntaxKey);
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

  test("preserves selected-path casing across Windows and POSIX hosts", () => {
    expect(
      deriveProjectGroupKey({
        rootPath: "c:\\repo\\Packages\\App",
        remoteUrl: "git@github.com:getpaseo/paseo.git",
        worktreeRoot: "C:\\Repo",
        mainRepoRoot: "C:\\Repo",
      }),
    ).toBe("remote:github.com/getpaseo/paseo#subdir:Packages/App");
  });

  test.skipIf(process.platform === "win32")(
    "preserves a selected subproject reached through a symlink",
    () => {
      const tempDir = mkdtempSync(path.join(tmpdir(), "project-group-key-"));
      try {
        const worktreeRoot = path.join(tempDir, "repo");
        const selectedRoot = path.join(worktreeRoot, "packages", "app");
        const linkedRoot = path.join(tempDir, "app-link");
        mkdirSync(selectedRoot, { recursive: true });
        symlinkSync(selectedRoot, linkedRoot, "dir");

        expect(
          deriveProjectGroupKey({
            rootPath: linkedRoot,
            remoteUrl: "git@github.com:getpaseo/paseo.git",
            worktreeRoot,
            mainRepoRoot: worktreeRoot,
          }),
        ).toBe("remote:github.com/getpaseo/paseo#subdir:packages/app");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );
});
