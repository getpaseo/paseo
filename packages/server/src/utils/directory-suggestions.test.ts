import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPlatform } from "../test-utils/platform.js";
import { searchHomeDirectories, searchWorkspaceEntries } from "./directory-suggestions.js";

const isWindows = isPlatform("win32");

describe("searchHomeDirectories", () => {
  let tempRoot: string;
  let homeDir: string;
  let outsideDir: string;

  beforeEach(() => {
    tempRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "directory-suggestions-")));
    homeDir = path.join(tempRoot, "home");
    outsideDir = path.join(tempRoot, "outside");

    mkdirSync(homeDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    homeDir = realpathSync(homeDir);
    outsideDir = realpathSync(outsideDir);

    mkdirSync(path.join(homeDir, "projects", "paseo"), { recursive: true });
    mkdirSync(path.join(homeDir, "projects", "playground"), { recursive: true });
    mkdirSync(path.join(homeDir, "documents", "plans"), { recursive: true });
    mkdirSync(path.join(homeDir, ".hidden", "cache"), { recursive: true });
    writeFileSync(path.join(homeDir, "projects", "README.md"), "not a directory\n");

    mkdirSync(path.join(outsideDir, "outside-match"), { recursive: true });
    if (!isWindows) {
      symlinkSync(path.join(outsideDir, "outside-match"), path.join(homeDir, "outside-link"));
    }
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("returns an empty list for blank queries", async () => {
    await expect(
      searchHomeDirectories({
        homeDir,
        query: "   ",
        limit: 10,
      }),
    ).resolves.toEqual([]);
  });

  it("returns only existing directories", async () => {
    const results = await searchHomeDirectories({
      homeDir,
      query: "proj",
      limit: 10,
    });

    const resolvedResults = results.map((result) => realpathSync.native(result));
    expect(resolvedResults).toContain(realpathSync.native(path.join(homeDir, "projects")));
    expect(resolvedResults).toContain(realpathSync.native(path.join(homeDir, "projects", "paseo")));
    expect(results).not.toContain(path.join(homeDir, "projects", "README.md"));
  });

  it("supports home-relative path query syntax", async () => {
    const results = await searchHomeDirectories({
      homeDir,
      query: "~/projects/pa",
      limit: 10,
    });

    expect(results.map((result) => realpathSync.native(result))).toEqual([
      realpathSync.native(path.join(homeDir, "projects", "paseo")),
    ]);
  });

  it("prioritizes exact segment matches before segment-prefix matches", async () => {
    const exactSegmentPath = path.join(homeDir, "something", "faro", "something-else");
    const prefixSegmentPath = path.join(homeDir, "something", "somethingelse", "faro-bla");
    mkdirSync(exactSegmentPath, { recursive: true });
    mkdirSync(prefixSegmentPath, { recursive: true });

    const results = await searchHomeDirectories({
      homeDir,
      query: "faro",
      limit: 30,
    });

    const resolvedResults = results.map((result) => realpathSync.native(result));
    const exactIndex = resolvedResults.indexOf(realpathSync.native(exactSegmentPath));
    const prefixIndex = resolvedResults.indexOf(realpathSync.native(prefixSegmentPath));
    expect(exactIndex).toBeGreaterThanOrEqual(0);
    expect(prefixIndex).toBeGreaterThanOrEqual(0);
    expect(exactIndex).toBeLessThan(prefixIndex);
  });

  it("does not let Python virtual environments crowd out top-level project matches", async () => {
    const projectPath = path.join(homeDir, "django-po-merge");
    mkdirSync(projectPath, { recursive: true });
    const dependencyPaths = ["venv", "env", "virtualenv"].map((environmentDirectoryName) =>
      path.join(
        homeDir,
        `${environmentDirectoryName}-project`,
        environmentDirectoryName,
        "Lib",
        "site-packages",
        "django",
      ),
    );
    for (const dependencyPath of dependencyPaths) {
      mkdirSync(dependencyPath, { recursive: true });
    }

    const results = await searchHomeDirectories({
      homeDir,
      query: "~/django",
      limit: 30,
    });

    const resolvedResults = results.map((result) => realpathSync.native(result));
    const projectIndex = resolvedResults.indexOf(realpathSync.native(projectPath));
    expect(projectIndex).toBeGreaterThanOrEqual(0);
    for (const dependencyPath of dependencyPaths) {
      expect(resolvedResults).not.toContain(realpathSync.native(dependencyPath));
    }
  });

  it("prioritizes partial matches that appear earlier in the path", async () => {
    const earlierPath = path.join(homeDir, "farofoo");
    const laterPath = path.join(homeDir, "x", "y", "farofoo");
    mkdirSync(earlierPath, { recursive: true });
    mkdirSync(laterPath, { recursive: true });

    const results = await searchHomeDirectories({
      homeDir,
      query: "arofo",
      limit: 30,
    });

    const resolvedResults = results.map((result) => realpathSync.native(result));
    const earlierIndex = resolvedResults.indexOf(realpathSync.native(earlierPath));
    const laterIndex = resolvedResults.indexOf(realpathSync.native(laterPath));
    expect(earlierIndex).toBeGreaterThanOrEqual(0);
    expect(laterIndex).toBeGreaterThanOrEqual(0);
    expect(earlierIndex).toBeLessThan(laterIndex);
  });

  it.skipIf(isWindows)("returns home-root suggestions when query is '~'", async () => {
    const results = await searchHomeDirectories({
      homeDir,
      query: "~",
      limit: 20,
    });

    expect(results).toContain(path.join(homeDir, "projects"));
    expect(results).toContain(path.join(homeDir, "documents"));
    expect(results).not.toContain(path.join(homeDir, ".hidden"));
  });

  it("does not return hidden directories during tree search", async () => {
    const results = await searchHomeDirectories({
      homeDir,
      query: "cache",
      limit: 20,
    });

    expect(results).not.toContain(path.join(homeDir, ".hidden", "cache"));
  });

  // POSIX-only: creates and follows a symlink escape fixture.
  it.skipIf(isWindows)("does not return paths that escape home through symlinks", async () => {
    const results = await searchHomeDirectories({
      homeDir,
      query: "outside",
      limit: 20,
    });

    expect(results).not.toContain(path.join(homeDir, "outside-link"));
    expect(results).not.toContain(path.join(outsideDir, "outside-match"));
  });

  it("respects the result limit", async () => {
    const results = await searchHomeDirectories({
      homeDir,
      query: "p",
      limit: 1,
    });

    expect(results).toHaveLength(1);
  });
});

describe("searchWorkspaceEntries", () => {
  let tempRoot: string;
  let workspaceDir: string;
  let outsideDir: string;

  beforeEach(() => {
    tempRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "workspace-suggestions-")));
    workspaceDir = path.join(tempRoot, "workspace");
    outsideDir = path.join(tempRoot, "outside");

    mkdirSync(path.join(workspaceDir, "src", "components"), {
      recursive: true,
    });
    mkdirSync(path.join(workspaceDir, "docs"), { recursive: true });
    mkdirSync(path.join(outsideDir, "escaped"), { recursive: true });

    writeFileSync(path.join(workspaceDir, "README.md"), "# paseo\n");
    writeFileSync(
      path.join(workspaceDir, "src", "components", "chat-input.tsx"),
      "export const ChatInput = null;\n",
    );
    writeFileSync(path.join(workspaceDir, "docs", "notes.md"), "notes\n");

    if (!isWindows) {
      symlinkSync(path.join(outsideDir, "escaped"), path.join(workspaceDir, "escaped-link"));
    }
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("returns relative file and directory suggestions for workspace queries", async () => {
    const results = await searchWorkspaceEntries({
      cwd: workspaceDir,
      query: "chat",
      limit: 20,
      includeFiles: true,
      includeDirectories: true,
    });

    expect(results).toContainEqual({
      path: "src/components/chat-input.tsx",
      kind: "file",
    });
    expect(results.some((entry) => entry.path === path.join(workspaceDir, "src"))).toBe(false);
  });

  it("filters entries by kind", async () => {
    const dirsOnly = await searchWorkspaceEntries({
      cwd: workspaceDir,
      query: "src",
      limit: 20,
      includeFiles: false,
      includeDirectories: true,
    });
    expect(dirsOnly.some((entry) => entry.kind === "file")).toBe(false);
    expect(dirsOnly.some((entry) => entry.path === "src")).toBe(true);

    const filesOnly = await searchWorkspaceEntries({
      cwd: workspaceDir,
      query: "readme",
      limit: 20,
      includeFiles: true,
      includeDirectories: false,
    });
    expect(filesOnly).toEqual([{ path: "README.md", kind: "file" }]);
  });

  it("supports fuzzy basename queries for nested workspace files", async () => {
    writeFileSync(path.join(workspaceDir, "src", "components", "message-renderer.tsx"), "");

    const results = await searchWorkspaceEntries({
      cwd: workspaceDir,
      query: "msgrndr",
      limit: 20,
      includeFiles: true,
      includeDirectories: false,
    });

    expect(results).toEqual([
      {
        path: "src/components/message-renderer.tsx",
        kind: "file",
      },
    ]);
  });

  it("ranks fuzzy basename matches after exact, prefix, and substring matches", async () => {
    writeFileSync(path.join(workspaceDir, "src", "components", "msgrndr"), "");
    writeFileSync(path.join(workspaceDir, "src", "components", "msgrndr-panel.tsx"), "");
    writeFileSync(path.join(workspaceDir, "src", "components", "use-msgrndr.ts"), "");
    writeFileSync(path.join(workspaceDir, "src", "components", "message-renderer.tsx"), "");

    const results = await searchWorkspaceEntries({
      cwd: workspaceDir,
      query: "msgrndr",
      limit: 20,
      includeFiles: true,
      includeDirectories: false,
    });

    expect(results.map((entry) => entry.path)).toEqual([
      "src/components/msgrndr",
      "src/components/msgrndr-panel.tsx",
      "src/components/use-msgrndr.ts",
      "src/components/message-renderer.tsx",
    ]);
  });

  it("suffix mode matches whole path segment suffixes without fuzzy matches", async () => {
    mkdirSync(path.join(workspaceDir, "packages", "app", "src"), { recursive: true });
    writeFileSync(path.join(workspaceDir, "src", "file.ts"), "");
    writeFileSync(path.join(workspaceDir, "packages", "app", "src", "file.ts"), "");
    writeFileSync(path.join(workspaceDir, "src", "paseo-config-file.ts"), "");

    const basenameResults = await searchWorkspaceEntries({
      cwd: workspaceDir,
      query: "file.ts",
      limit: 20,
      includeFiles: true,
      includeDirectories: false,
      matchMode: "suffix",
    });
    const suffixResults = await searchWorkspaceEntries({
      cwd: workspaceDir,
      query: "src/file.ts",
      limit: 20,
      includeFiles: true,
      includeDirectories: false,
      matchMode: "suffix",
    });

    expect(basenameResults).toEqual([
      { path: "src/file.ts", kind: "file" },
      { path: "packages/app/src/file.ts", kind: "file" },
    ]);
    expect(suffixResults).toEqual([
      { path: "src/file.ts", kind: "file" },
      { path: "packages/app/src/file.ts", kind: "file" },
    ]);
  });

  it("suffix mode resolves exact workspace file paths before broad traversal", async () => {
    const targetPath = path.join(
      workspaceDir,
      "packages",
      "server",
      "src",
      "services",
      "quota-fetcher",
      "providers",
      "local.ts",
    );
    mkdirSync(path.dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, "");

    const results = await searchWorkspaceEntries({
      cwd: workspaceDir,
      query: "packages/server/src/services/quota-fetcher/providers/local.ts",
      limit: 20,
      includeFiles: true,
      includeDirectories: false,
      matchMode: "suffix",
      maxEntriesScanned: 1,
    });

    expect(results).toEqual([
      {
        path: "packages/server/src/services/quota-fetcher/providers/local.ts",
        kind: "file",
      },
    ]);
  });

  it("suffix mode resolves explicit hidden file paths without broad hidden traversal", async () => {
    const targetPath = path.join(workspaceDir, ".dev", "paseo-home", "daemon.log");
    mkdirSync(path.dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, "daemon log\n");

    const results = await searchWorkspaceEntries({
      cwd: workspaceDir,
      query: ".dev/paseo-home/daemon.log",
      limit: 20,
      includeFiles: true,
      includeDirectories: false,
      matchMode: "suffix",
      maxEntriesScanned: 1,
    });

    expect(results).toEqual([{ path: ".dev/paseo-home/daemon.log", kind: "file" }]);
  });

  it("suffix mode finds files under allowlisted hidden workspace directories", async () => {
    mkdirSync(path.join(workspaceDir, ".claude"), { recursive: true });
    mkdirSync(path.join(workspaceDir, ".github", "workflows"), { recursive: true });
    writeFileSync(path.join(workspaceDir, ".claude", "settings.local.json"), "{}");
    writeFileSync(path.join(workspaceDir, ".github", "workflows", "ci.yml"), "");

    const claudeResults = await searchWorkspaceEntries({
      cwd: workspaceDir,
      query: "settings.local.json",
      limit: 20,
      includeFiles: true,
      includeDirectories: false,
      matchMode: "suffix",
    });
    const githubResults = await searchWorkspaceEntries({
      cwd: workspaceDir,
      query: "ci.yml",
      limit: 20,
      includeFiles: true,
      includeDirectories: false,
      matchMode: "suffix",
    });

    expect(claudeResults).toEqual([{ path: ".claude/settings.local.json", kind: "file" }]);
    expect(githubResults).toEqual([{ path: ".github/workflows/ci.yml", kind: "file" }]);
  });

  it("does not broadly traverse unlisted hidden workspace directories", async () => {
    mkdirSync(path.join(workspaceDir, ".dev", "cache"), { recursive: true });
    writeFileSync(path.join(workspaceDir, ".dev", "cache", "needle.ts"), "");
    writeFileSync(path.join(workspaceDir, "src", "needle.ts"), "");

    const results = await searchWorkspaceEntries({
      cwd: workspaceDir,
      query: "needle.ts",
      limit: 20,
      includeFiles: true,
      includeDirectories: false,
      matchMode: "suffix",
    });

    expect(results).toEqual([{ path: "src/needle.ts", kind: "file" }]);
  });

  it("does not suggest hidden directories even when includeDirectories is true", async () => {
    mkdirSync(path.join(workspaceDir, ".claude"), { recursive: true });
    writeFileSync(path.join(workspaceDir, ".claude", "settings.local.json"), "{}");

    const results = await searchWorkspaceEntries({
      cwd: workspaceDir,
      query: "claude",
      limit: 20,
      includeFiles: true,
      includeDirectories: true,
      matchMode: "fuzzy",
    });

    expect(results.some((entry) => entry.path === ".claude" && entry.kind === "directory")).toBe(
      false,
    );
    expect(results).toContainEqual({
      path: ".claude/settings.local.json",
      kind: "file",
    });
  });

  it("path mode does not suggest hidden workspace directories", async () => {
    mkdirSync(path.join(workspaceDir, ".claude"), { recursive: true });
    writeFileSync(path.join(workspaceDir, ".claude", "settings.local.json"), "{}");

    const results = await searchWorkspaceEntries({
      cwd: workspaceDir,
      query: "./",
      limit: 20,
      includeFiles: true,
      includeDirectories: true,
      matchMode: "fuzzy",
    });

    expect(results).toContainEqual({
      path: "README.md",
      kind: "file",
    });
    expect(results.some((entry) => entry.path === ".claude" && entry.kind === "directory")).toBe(
      false,
    );
  });

  it("does not traverse .git while searching workspace files", async () => {
    mkdirSync(path.join(workspaceDir, ".git", "objects", "ab"), { recursive: true });
    writeFileSync(path.join(workspaceDir, ".git", "objects", "ab", "deadbeef"), "");

    const results = await searchWorkspaceEntries({
      cwd: workspaceDir,
      query: "deadbeef",
      limit: 20,
      includeFiles: true,
      includeDirectories: false,
      matchMode: "suffix",
    });

    expect(results).toEqual([]);
  });

  // POSIX-only: creates and follows a symlink escape fixture.
  it.skipIf(isWindows)(
    "supports path-style queries and does not escape cwd through symlinks",
    async () => {
      const pathResults = await searchWorkspaceEntries({
        cwd: workspaceDir,
        query: "src/co",
        limit: 20,
        includeFiles: true,
        includeDirectories: true,
      });
      expect(pathResults).toContainEqual({
        path: "src/components",
        kind: "directory",
      });

      const escapedResults = await searchWorkspaceEntries({
        cwd: workspaceDir,
        query: "escaped",
        limit: 20,
        includeFiles: true,
        includeDirectories: true,
      });
      expect(escapedResults.some((entry) => entry.path.includes("escaped-link"))).toBe(false);
    },
  );

  it("ignores node_modules entries so deep workspace files still resolve under scan limits", async () => {
    mkdirSync(path.join(workspaceDir, "packages", "app", "src", "app"), { recursive: true });
    writeFileSync(path.join(workspaceDir, "packages", "app", "src", "app", "_layout.tsx"), "");

    for (let index = 0; index < 120; index += 1) {
      mkdirSync(path.join(workspaceDir, "node_modules", `pkg-${index}`), { recursive: true });
      writeFileSync(
        path.join(workspaceDir, "node_modules", `pkg-${index}`, "index.js"),
        "module.exports = {};\n",
      );
    }
    writeFileSync(path.join(workspaceDir, "node_modules", "_layout.tsx"), "");

    const results = await searchWorkspaceEntries({
      cwd: workspaceDir,
      query: "_layout.tsx",
      limit: 20,
      includeFiles: true,
      includeDirectories: true,
      maxEntriesScanned: 60,
    });

    expect(results).toContainEqual({
      path: "packages/app/src/app/_layout.tsx",
      kind: "file",
    });
    expect(results.some((entry) => entry.path.startsWith("node_modules/"))).toBe(false);
  });

  it("ignores common build/cache directories so large generated trees do not exhaust scan budget", async () => {
    mkdirSync(path.join(workspaceDir, "packages", "app", "src"), { recursive: true });
    writeFileSync(path.join(workspaceDir, "packages", "app", "src", "needle.ts"), "");

    const heavyDirs = ["dist", "build", "target", "out", "coverage", "vendor", "__pycache__"];
    for (const heavyDir of heavyDirs) {
      for (let index = 0; index < 30; index += 1) {
        mkdirSync(path.join(workspaceDir, heavyDir, `bundle-${index}`), { recursive: true });
        writeFileSync(path.join(workspaceDir, heavyDir, `bundle-${index}`, "needle.ts"), "");
      }
    }

    const results = await searchWorkspaceEntries({
      cwd: workspaceDir,
      query: "needle.ts",
      limit: 20,
      includeFiles: true,
      includeDirectories: true,
      maxEntriesScanned: 80,
    });

    expect(results).toContainEqual({
      path: "packages/app/src/needle.ts",
      kind: "file",
    });
    for (const heavyDir of heavyDirs) {
      expect(results.some((entry) => entry.path.startsWith(`${heavyDir}/`))).toBe(false);
    }
  });
});
