import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { deriveProjectGroupKey, deriveProjectGroupingDisplayName } from "./project-group-key.js";

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
    ).toBe("remote:git.example.com:8443/acme/app.git");
  });

  test("normalizes the default SSH port", () => {
    const rootPath = path.resolve("repo");
    const derive = (remoteUrl: string) =>
      deriveProjectGroupKey({
        rootPath,
        remoteUrl,
        worktreeRoot: rootPath,
        mainRepoRoot: null,
      });

    expect(derive("ssh://git@github.com:22/getpaseo/paseo.git")).toBe(
      derive("ssh://git@github.com/getpaseo/paseo.git"),
    );
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
    ).toBe("remote:git.example.com/repo.git");
  });

  test("preserves meaningful dot-git suffixes on unknown Git servers", () => {
    const rootPath = path.resolve("repo");
    const derive = (remoteUrl: string) =>
      deriveProjectGroupKey({
        rootPath,
        remoteUrl,
        worktreeRoot: rootPath,
        mainRepoRoot: null,
      });

    expect(derive("git@example.com:repos/foo.git")).not.toBe(derive("git@example.com:repos/foo"));
  });

  test("normalizes dot-git suffixes on known cloud forges", () => {
    const rootPath = path.resolve("repo");
    const derive = (remoteUrl: string) =>
      deriveProjectGroupKey({
        rootPath,
        remoteUrl,
        worktreeRoot: rootPath,
        mainRepoRoot: null,
      });

    expect(derive("git@github.com:acme/foo.git")).toBe(derive("https://github.com/acme/foo"));
  });

  test.each(["ssh://git@github.com/acme/foo.git", "ssh://git@ssh.github.com:443/acme/foo.git"])(
    "normalizes known forge SSH URLs across remote forms: %s",
    (remoteUrl) => {
      const rootPath = path.resolve("repo");
      const derive = (value: string) =>
        deriveProjectGroupKey({
          rootPath,
          remoteUrl: value,
          worktreeRoot: rootPath,
          mainRepoRoot: null,
        });

      expect(derive(remoteUrl)).toBe(derive("git@github.com:acme/foo.git"));
    },
  );

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

  test("distinguishes absolute and home-relative SCP paths", () => {
    const rootPath = path.resolve("repo");
    const derive = (remoteUrl: string) =>
      deriveProjectGroupKey({
        rootPath,
        remoteUrl,
        worktreeRoot: rootPath,
        mainRepoRoot: null,
      });

    expect(derive("example.com:srv/repo.git")).not.toBe(derive("example.com:/srv/repo.git"));
  });

  test("distinguishes absolute SSH URL paths from home-relative SCP paths", () => {
    const rootPath = path.resolve("repo");
    const derive = (remoteUrl: string) =>
      deriveProjectGroupKey({
        rootPath,
        remoteUrl,
        worktreeRoot: rootPath,
        mainRepoRoot: null,
      });

    expect(derive("ssh://git@example.com/srv/repo.git")).not.toBe(
      derive("git@example.com:srv/repo.git"),
    );
  });

  test("distinguishes SSH users for home-relative SCP paths", () => {
    const rootPath = path.resolve("repo");
    const derive = (remoteUrl: string) =>
      deriveProjectGroupKey({
        rootPath,
        remoteUrl,
        worktreeRoot: rootPath,
        mainRepoRoot: null,
      });

    expect(derive("alice@git.example.com:repo.git")).not.toBe(
      derive("bob@git.example.com:repo.git"),
    );
  });

  test("keeps percent sequences literal in SCP paths", () => {
    const rootPath = path.resolve("repo");
    const derive = (remoteUrl: string) =>
      deriveProjectGroupKey({
        rootPath,
        remoteUrl,
        worktreeRoot: rootPath,
        mainRepoRoot: null,
      });

    expect(derive("git.example.com:acme/repo%41.git")).not.toBe(
      derive("git.example.com:acme/repoA.git"),
    );
  });

  test("preserves leading whitespace in SCP repository paths", () => {
    const rootPath = path.resolve("repo");
    const derive = (remoteUrl: string) =>
      deriveProjectGroupKey({
        rootPath,
        remoteUrl,
        worktreeRoot: rootPath,
        mainRepoRoot: null,
      });

    expect(derive("git@example.com: acme/repo.git")).not.toBe(
      derive("git@example.com:acme/repo.git"),
    );
  });

  test("does not parse drive-relative Windows paths as SCP remotes", () => {
    const rootPath = path.resolve("repo");

    expect(
      deriveProjectGroupKey({
        rootPath,
        remoteUrl: "C:repo",
        worktreeRoot: rootPath,
        mainRepoRoot: null,
      }),
    ).toBe(rootPath);
  });

  test.each(["git+ssh:", "ssh+git:"])("normalizes SSH alias default ports for %s", (scheme) => {
    const rootPath = path.resolve("repo");
    const derive = (remoteUrl: string) =>
      deriveProjectGroupKey({
        rootPath,
        remoteUrl,
        worktreeRoot: rootPath,
        mainRepoRoot: null,
      });

    expect(derive(`${scheme}//git@github.com:22/getpaseo/paseo.git`)).toBe(
      derive("ssh://git@github.com/getpaseo/paseo.git"),
    );
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
    ).toBe("remote:[2001:db8::1]/getpaseo/paseo.git");
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

describe("deriveProjectGroupingDisplayName", () => {
  test.each([
    ["https://example.com/acme/my%20repo.git", "acme/my repo"],
    ["git@example.com:acme/my repo.git", "acme/my repo"],
    ["git@example.com:acme/my#repo.git", "acme/my#repo"],
    ["git@example.com:acme/my%repo.git", "acme/my%repo"],
  ])("derives a decoded display name from %s", (remoteUrl, expected) => {
    const rootPath = path.resolve("repo");

    expect(deriveProjectGroupingDisplayName({ rootPath, remoteUrl, worktreeRoot: rootPath })).toBe(
      expected,
    );
  });
});
