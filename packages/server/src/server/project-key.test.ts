import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { deriveProjectKey, deriveProjectGroupingDisplayName } from "./project-key.js";

function canonicalPlatformPath(input: string): string {
  return process.platform === "win32" ? input.toLowerCase() : input;
}

describe("deriveProjectKey", () => {
  test("preserves an explicit remote port", () => {
    const rootPath = path.resolve("repo");

    expect(
      deriveProjectKey({
        rootPath,
        remoteUrl: "https://git.example.com:8443/acme/app.git",
        worktreeRoot: rootPath,
        mainRepoRoot: null,
      }),
    ).toBe("remote:https://git.example.com:8443/acme/app.git");
  });

  test("distinguishes transports for generic URL remotes", () => {
    const rootPath = path.resolve("repo");
    const derive = (remoteUrl: string) =>
      deriveProjectKey({
        rootPath,
        remoteUrl,
        worktreeRoot: rootPath,
        mainRepoRoot: null,
      });

    expect(derive("http://git.example.com:80/acme/app.git")).not.toBe(
      derive("https://git.example.com:443/acme/app.git"),
    );
  });

  test("preserves queries that distinguish generic HTTP remotes", () => {
    const rootPath = path.resolve("repo");
    const derive = (remoteUrl: string) =>
      deriveProjectKey({
        rootPath,
        remoteUrl,
        worktreeRoot: rootPath,
        mainRepoRoot: null,
      });

    expect(derive("https://git.example.com/acme/app.git?tenant=a")).not.toBe(
      derive("https://git.example.com/acme/app.git?tenant=b"),
    );
  });

  test("normalizes the default SSH port", () => {
    const rootPath = path.resolve("repo");
    const derive = (remoteUrl: string) =>
      deriveProjectKey({
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
      deriveProjectKey({
        rootPath,
        remoteUrl: "https://git.example.com/repo.git",
        worktreeRoot: rootPath,
        mainRepoRoot: null,
      }),
    ).toBe("remote:https://git.example.com/repo.git");
  });

  test("preserves meaningful dot-git suffixes on unknown Git servers", () => {
    const rootPath = path.resolve("repo");
    const derive = (remoteUrl: string) =>
      deriveProjectKey({
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
      deriveProjectKey({
        rootPath,
        remoteUrl,
        worktreeRoot: rootPath,
        mainRepoRoot: null,
      });

    expect(derive("git@github.com:acme/foo.git")).toBe(derive("https://github.com/acme/foo"));
  });

  test("normalizes GitHub owner and repository casing", () => {
    const rootPath = path.resolve("repo");
    const derive = (remoteUrl: string) =>
      deriveProjectKey({
        rootPath,
        remoteUrl,
        worktreeRoot: rootPath,
        mainRepoRoot: null,
      });

    expect(derive("git@github.com:GetPaseo/Paseo.git")).toBe(
      derive("https://github.com/getpaseo/paseo.git"),
    );
  });

  test.each(["ssh://git@github.com/acme/foo.git", "ssh://git@ssh.github.com:443/acme/foo.git"])(
    "normalizes known forge SSH URLs across remote forms: %s",
    (remoteUrl) => {
      const rootPath = path.resolve("repo");
      const derive = (value: string) =>
        deriveProjectKey({
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
      deriveProjectKey({
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
      deriveProjectKey({
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
      deriveProjectKey({
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
      deriveProjectKey({
        rootPath,
        remoteUrl,
        worktreeRoot: rootPath,
        mainRepoRoot: null,
      });

    expect(derive("alice@git.example.com:repo.git")).not.toBe(
      derive("bob@git.example.com:repo.git"),
    );
  });

  test("distinguishes SSH users for absolute SCP paths", () => {
    const rootPath = path.resolve("repo");
    const derive = (remoteUrl: string) =>
      deriveProjectKey({
        rootPath,
        remoteUrl,
        worktreeRoot: rootPath,
        mainRepoRoot: null,
      });

    expect(derive("alice@git.example.com:/srv/repo.git")).not.toBe(
      derive("bob@git.example.com:/srv/repo.git"),
    );
  });

  test("distinguishes SSH users for generic URL remotes", () => {
    const rootPath = path.resolve("repo");
    const derive = (remoteUrl: string) =>
      deriveProjectKey({
        rootPath,
        remoteUrl,
        worktreeRoot: rootPath,
        mainRepoRoot: null,
      });

    expect(derive("ssh://alice@git.example.com/srv/repo.git")).not.toBe(
      derive("ssh://bob@git.example.com/srv/repo.git"),
    );
  });

  test("preserves an explicit git user on generic SSH hosts", () => {
    const rootPath = path.resolve("repo");
    const derive = (remoteUrl: string) =>
      deriveProjectKey({
        rootPath,
        remoteUrl,
        worktreeRoot: rootPath,
        mainRepoRoot: null,
      });

    expect(derive("git@example.com:repo.git")).not.toBe(derive("example.com:repo.git"));
    expect(derive("ssh://git@example.com/repo.git")).not.toBe(derive("ssh://example.com/repo.git"));
  });

  test("normalizes equivalent absolute SSH remote forms", () => {
    const rootPath = path.resolve("repo");
    const derive = (remoteUrl: string) =>
      deriveProjectKey({
        rootPath,
        remoteUrl,
        worktreeRoot: rootPath,
        mainRepoRoot: null,
      });

    expect(derive("git@example.com:/srv/repo.git")).toBe(
      derive("ssh://git@example.com/srv/repo.git"),
    );
  });

  test("preserves query and fragment text in SSH repository paths", () => {
    const rootPath = path.resolve("repo");
    const derive = (remoteUrl: string) =>
      deriveProjectKey({
        rootPath,
        remoteUrl,
        worktreeRoot: rootPath,
        mainRepoRoot: null,
      });

    expect(derive("ssh://git@example.com/repo.git?x=1#one")).not.toBe(
      derive("ssh://git@example.com/repo.git?x=2#two"),
    );
  });

  test("keeps percent sequences literal in SCP paths", () => {
    const rootPath = path.resolve("repo");
    const derive = (remoteUrl: string) =>
      deriveProjectKey({
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
      deriveProjectKey({
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
      deriveProjectKey({
        rootPath,
        remoteUrl: "C:repo",
        worktreeRoot: rootPath,
        mainRepoRoot: null,
      }),
    ).toBe(canonicalPlatformPath(rootPath));
  });

  test.each(["git+ssh:", "ssh+git:"])("normalizes SSH alias default ports for %s", (scheme) => {
    const rootPath = path.resolve("repo");
    const derive = (remoteUrl: string) =>
      deriveProjectKey({
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
      deriveProjectKey({
        rootPath,
        remoteUrl: "git@[2001:db8::1]:getpaseo/paseo.git",
        worktreeRoot: rootPath,
        mainRepoRoot: null,
      }),
    ).toBe("remote:git@[2001:db8::1]/getpaseo/paseo.git");
  });

  test("includes the selected path within a repository", () => {
    const worktreeRoot = path.resolve("repo");
    const rootPath = path.join(worktreeRoot, "packages", "app");

    expect(
      deriveProjectKey({
        rootPath,
        remoteUrl: "git@github.com:getpaseo/paseo.git",
        worktreeRoot,
        mainRepoRoot: null,
      }),
    ).toBe("remote:github.com/getpaseo/paseo#subdir:packages/app");
  });

  test.skipIf(process.platform === "win32")(
    "preserves backslashes in POSIX selected path segments",
    () => {
      const worktreeRoot = "/repo";
      const derive = (rootPath: string) =>
        deriveProjectKey({
          rootPath,
          remoteUrl: "git@github.com:getpaseo/paseo.git",
          worktreeRoot,
          mainRepoRoot: null,
        });

      expect(derive("/repo/foo\\bar")).toBe("remote:github.com/getpaseo/paseo#subdir:foo%5Cbar");
      expect(derive("/repo/foo\\bar")).not.toBe(derive("/repo/foo/bar"));
    },
  );

  test("keeps a selected path distinct from remote path syntax", () => {
    const worktreeRoot = path.resolve("repo");
    const selectedKey = deriveProjectKey({
      rootPath: path.join(worktreeRoot, "packages", "app"),
      remoteUrl: "example.com:acme/repo.git",
      worktreeRoot,
      mainRepoRoot: null,
    });
    const remoteSyntaxKey = deriveProjectKey({
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
      deriveProjectKey({
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
      deriveProjectKey({
        rootPath: path.join(worktreeRoot, "packages", "app"),
        remoteUrl: null,
        worktreeRoot,
        mainRepoRoot,
      }),
    ).toBe(canonicalPlatformPath(path.join(mainRepoRoot, "packages", "app")));
  });

  test("keeps path-only project identities scoped to their host", () => {
    const rootPath = path.resolve("repo");
    const derive = (serverId: string) =>
      deriveProjectKey({
        rootPath,
        remoteUrl: null,
        worktreeRoot: null,
        mainRepoRoot: null,
        serverId,
      });

    expect(derive("host-a")).not.toBe(derive("host-b"));
    expect(derive("host-a")).toBe(`host:6:host-a:path:${canonicalPlatformPath(rootPath)}`);
  });

  test("preserves selected-path casing across Windows and POSIX hosts", () => {
    expect(
      deriveProjectKey({
        rootPath: "c:\\repo\\Packages\\App",
        remoteUrl: "git@github.com:getpaseo/paseo.git",
        worktreeRoot: "C:\\Repo",
        mainRepoRoot: "C:\\Repo",
      }),
    ).toBe("remote:github.com/getpaseo/paseo#subdir:packages/app");

    expect(
      deriveProjectKey({
        rootPath: "c:\\repo\\packages\\app",
        remoteUrl: "git@github.com:getpaseo/paseo.git",
        worktreeRoot: "c:\\repo",
        mainRepoRoot: "c:\\repo",
      }),
    ).toBe("remote:github.com/getpaseo/paseo#subdir:packages/app");
  });

  test("stabilizes host-local Windows paths across equivalent spellings", () => {
    const derive = (rootPath: string) =>
      deriveProjectKey({
        rootPath,
        remoteUrl: null,
        worktreeRoot: null,
        mainRepoRoot: null,
        serverId: "host-a",
      });

    expect(derive("C:\\Users\\Paseo\\Repo")).toBe(derive("c:/users/paseo/repo/."));
  });

  test.skipIf(process.platform === "win32")(
    "preserves a selected subproject reached through a symlink",
    () => {
      const tempDir = mkdtempSync(path.join(tmpdir(), "project-key-"));
      try {
        const worktreeRoot = path.join(tempDir, "repo");
        const selectedRoot = path.join(worktreeRoot, "packages", "app");
        const linkedRoot = path.join(tempDir, "app-link");
        mkdirSync(selectedRoot, { recursive: true });
        symlinkSync(selectedRoot, linkedRoot, "dir");

        expect(
          deriveProjectKey({
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

  test("excludes a generic HTTP query from the display name", () => {
    expect(
      deriveProjectGroupingDisplayName({
        rootPath: path.resolve("repo"),
        remoteUrl: "https://git.example.com/acme/app.git?token=secret",
        worktreeRoot: path.resolve("repo"),
      }),
    ).toBe("acme/app");
  });
});
