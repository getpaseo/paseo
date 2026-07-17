import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPlatform } from "../test-utils/platform.js";
import {
  searchDirectoryEntries,
  WORKSPACE_SEARCH_HIDDEN_DIRECTORIES,
} from "./directory-suggestions.js";

const isWindows = isPlatform("win32");
const filesystemRootDirectoryName = isWindows ? "Windows" : "usr";
async function searchAbsoluteDirectoryPaths(options: {
  homeDir: string;
  query: string;
  limit?: number;
  maxDepth?: number;
  maxDirectoriesScanned?: number;
}): Promise<string[]> {
  const entries = await searchDirectoryEntries({
    root: options.homeDir,
    query: options.query,
    pathFormat: "absolute",
    includeDirectories: true,
    includeFiles: false,
    pathQueryPolicy: "rooted",
    rootAliases: ["~"],
    blankQueryBehavior: "none",
    limit: options.limit,
    maxDepth: options.maxDepth,
    maxEntriesScanned: options.maxDirectoriesScanned,
    confidentResultScanThreshold: 5_000,
  });
  return entries.map((entry) => entry.path);
}

async function searchRelativeDirectoryEntries(options: {
  cwd: string;
  query: string;
  limit?: number;
  includeFiles?: boolean;
  includeDirectories?: boolean;
  matchMode?: "fuzzy" | "suffix";
  maxDepth?: number;
  maxEntriesScanned?: number;
}) {
  return searchDirectoryEntries({
    root: options.cwd,
    query: options.query,
    pathFormat: "relative",
    includeFiles: options.includeFiles,
    includeDirectories: options.includeDirectories,
    matchMode: options.matchMode,
    pathQueryPolicy: "slashes",
    blankQueryBehavior: "children",
    traversableHiddenDirectoryNames: WORKSPACE_SEARCH_HIDDEN_DIRECTORIES,
    limit: options.limit,
    maxDepth: options.maxDepth,
    maxEntriesScanned: options.maxEntriesScanned,
  });
}

describe("searchDirectoryEntries", () => {
  let configuredSearchRoot: string;
  let searchRoot: string;

  beforeEach(() => {
    configuredSearchRoot = mkdtempSync(path.join(tmpdir(), "directory-search-"));
    searchRoot = realpathSync.native(configuredSearchRoot);
    mkdirSync(path.join(searchRoot, "projects", "paseo-desktop"), { recursive: true });
    mkdirSync(path.join(searchRoot, "src", "components"), { recursive: true });
    mkdirSync(path.join(searchRoot, ".hidden", "secret"), { recursive: true });
    writeFileSync(path.join(searchRoot, "src", "components", "message-renderer.tsx"), "");
  });

  afterEach(() => {
    rmSync(searchRoot, { recursive: true, force: true });
  });

  it("applies result paths and entry kinds as parameters of one search", async () => {
    const directories = await searchDirectoryEntries({
      root: configuredSearchRoot,
      query: "pso",
      pathFormat: "absolute",
      includeFiles: false,
      includeDirectories: true,
    });
    const files = await searchDirectoryEntries({
      root: searchRoot,
      query: "msgrndr",
      pathFormat: "relative",
      includeFiles: true,
      includeDirectories: false,
    });

    expect({ directories, files }).toEqual({
      directories: [
        {
          path: path.join(searchRoot, "projects", "paseo-desktop"),
          kind: "directory",
        },
      ],
      files: [
        {
          path: "src/components/message-renderer.tsx",
          kind: "file",
        },
      ],
    });
  });

  it("configures raw blank queries independently from explicit root aliases", async () => {
    const rootEntries = [
      { path: "projects", kind: "directory" as const },
      { path: "src", kind: "directory" as const },
    ];
    const common = {
      root: searchRoot,
      pathFormat: "relative" as const,
      includeFiles: false,
      includeDirectories: true,
      rootAliases: ["~"],
    };

    await expect(
      searchDirectoryEntries({
        ...common,
        query: "",
        blankQueryBehavior: "none",
      }),
    ).resolves.toEqual([]);

    await expect(
      searchDirectoryEntries({
        ...common,
        query: "~",
        blankQueryBehavior: "none",
      }),
    ).resolves.toEqual(rootEntries);

    await expect(
      searchDirectoryEntries({
        ...common,
        query: "",
        blankQueryBehavior: "children",
      }),
    ).resolves.toEqual(rootEntries);

    const suffixRootBrowses = await Promise.all([
      searchDirectoryEntries({
        ...common,
        query: "",
        matchMode: "suffix",
        blankQueryBehavior: "children",
      }),
      searchDirectoryEntries({
        ...common,
        query: "~",
        matchMode: "suffix",
        blankQueryBehavior: "none",
      }),
    ]);
    expect(suffixRootBrowses).toEqual([rootEntries, rootEntries]);
  });

  it("anchors rooted one-segment queries to their root parent", async () => {
    mkdirSync(path.join(searchRoot, "nested", "pso-global"), { recursive: true });
    mkdirSync(path.join(searchRoot, "pso-root"), { recursive: true });
    const absoluteQuery = path.join(configuredSearchRoot, "pso");

    const common = {
      root: configuredSearchRoot,
      pathFormat: "relative" as const,
      includeFiles: false,
      includeDirectories: true,
      pathQueryPolicy: "rooted" as const,
      rootAliases: ["~"],
    };
    const expected = [{ path: "pso-root", kind: "directory" }];

    await expect(searchDirectoryEntries({ ...common, query: "~/pso" })).resolves.toEqual(expected);
    await expect(searchDirectoryEntries({ ...common, query: "./pso" })).resolves.toEqual(expected);
    await expect(searchDirectoryEntries({ ...common, query: absoluteQuery })).resolves.toEqual(
      expected,
    );
  });

  it("browses an absolute root and an absolute directory ending in a separator", async () => {
    const common = {
      root: configuredSearchRoot,
      pathFormat: "relative" as const,
      includeFiles: false,
      includeDirectories: true,
      pathQueryPolicy: "rooted" as const,
    };
    const rootEntries = await searchDirectoryEntries({ ...common, query: configuredSearchRoot });
    const projectEntries = await searchDirectoryEntries({
      ...common,
      query: `${path.join(configuredSearchRoot, "projects")}${path.sep}`,
    });

    expect({ rootEntries, projectEntries }).toEqual({
      rootEntries: [
        { path: "projects", kind: "directory" },
        { path: "src", kind: "directory" },
      ],
      projectEntries: [{ path: "projects/paseo-desktop", kind: "directory" }],
    });
  });

  it("anchors single-segment absolute queries when the search root is a filesystem root", async () => {
    const filesystemRoot = path.parse(searchRoot).root;
    const exactPath = path.join(filesystemRoot, filesystemRootDirectoryName);
    const incompletePath = exactPath.slice(0, -1);
    const common = {
      root: filesystemRoot,
      pathFormat: "absolute" as const,
      includeFiles: false,
      includeDirectories: true,
      pathQueryPolicy: "rooted" as const,
      limit: 5,
    };

    await expect(searchDirectoryEntries({ ...common, query: incompletePath })).resolves.toEqual([]);

    const exactEntries = await searchDirectoryEntries({ ...common, query: exactPath });
    expect(exactEntries[0]).toEqual({ path: exactPath, kind: "directory" });
    expect(
      exactEntries.every(
        (entry) => entry.path === exactPath || entry.path.startsWith(`${exactPath}${path.sep}`),
      ),
    ).toBe(true);
  });

  it("does not return entries below the configured traversal depth", async () => {
    await expect(
      searchDirectoryEntries({
        root: searchRoot,
        query: "message-renderer",
        pathFormat: "relative",
        includeFiles: true,
        includeDirectories: false,
        maxDepth: 2,
      }),
    ).resolves.toEqual([]);
  });

  it("does not spend the scan budget on excluded entry kinds", async () => {
    const budgetRoot = path.join(searchRoot, "kind-budget");
    const target = path.join(budgetRoot, "z-projects", "paseo-target");
    mkdirSync(target, { recursive: true });
    for (let index = 0; index < 10; index += 1) {
      writeFileSync(path.join(budgetRoot, `a-noise-${index}.txt`), "");
    }

    await expect(
      searchDirectoryEntries({
        root: budgetRoot,
        query: "paseo-target",
        pathFormat: "relative",
        includeFiles: false,
        includeDirectories: true,
        maxEntriesScanned: 2,
      }),
    ).resolves.toEqual([{ path: "z-projects/paseo-target", kind: "directory" }]);
  });

  it("applies ignored-directory policy to parent-scoped queries", async () => {
    mkdirSync(path.join(searchRoot, "node_modules"));

    await expect(
      searchDirectoryEntries({
        root: searchRoot,
        query: "./node",
        pathFormat: "relative",
        includeFiles: false,
        includeDirectories: true,
      }),
    ).resolves.toEqual([]);
  });

  it("does not traverse dependency, environment, or build-output directories", async () => {
    const ignoredNames = [
      "node_modules",
      "venv",
      "env",
      "virtualenv",
      "dist",
      "build",
      "target",
      "out",
      "coverage",
      "vendor",
      "__pycache__",
      ".git",
    ];
    for (const name of ignoredNames) {
      const ignoredTarget = path.join(searchRoot, name, "search-target.ts");
      mkdirSync(path.dirname(ignoredTarget), { recursive: true });
      writeFileSync(ignoredTarget, "");
    }
    const visibleTarget = path.join(searchRoot, "src", "search-target.ts");
    writeFileSync(visibleTarget, "");

    await expect(
      searchDirectoryEntries({
        root: searchRoot,
        query: "search-target.ts",
        pathFormat: "relative",
        includeFiles: true,
        includeDirectories: false,
      }),
    ).resolves.toEqual([{ path: "src/search-target.ts", kind: "file" }]);
  });

  it.skipIf(isWindows)("rechecks cached symlink children against each search root", async () => {
    const narrowRoot = path.join(searchRoot, "narrow");
    const outsideNarrowRoot = path.join(searchRoot, "outside");
    mkdirSync(narrowRoot, { recursive: true });
    mkdirSync(path.join(outsideNarrowRoot, "leaked-child"), { recursive: true });
    symlinkSync(outsideNarrowRoot, path.join(narrowRoot, "outside-link"));

    await searchDirectoryEntries({
      root: searchRoot,
      query: "leaked-child",
      pathFormat: "absolute",
      includeFiles: false,
      includeDirectories: true,
    });

    await expect(
      searchDirectoryEntries({
        root: narrowRoot,
        query: "outside",
        pathFormat: "relative",
        includeFiles: false,
        includeDirectories: true,
      }),
    ).resolves.toEqual([]);
  });

  it.skipIf(isWindows)("rechecks a cached symlink after its target changes", async () => {
    const narrowRoot = path.join(searchRoot, "retargeted-link-root");
    const insideTarget = path.join(narrowRoot, "inside");
    const outsideTarget = path.join(searchRoot, "retargeted-link-outside");
    const link = path.join(narrowRoot, "project-link");
    mkdirSync(insideTarget, { recursive: true });
    mkdirSync(outsideTarget, { recursive: true });
    symlinkSync(insideTarget, link);

    await expect(
      searchDirectoryEntries({
        root: narrowRoot,
        query: "project-link",
        pathFormat: "relative",
        includeFiles: false,
        includeDirectories: true,
      }),
    ).resolves.toEqual([{ path: "project-link", kind: "directory" }]);

    unlinkSync(link);
    symlinkSync(outsideTarget, link);

    await expect(
      searchDirectoryEntries({
        root: narrowRoot,
        query: "project-link",
        pathFormat: "relative",
        includeFiles: false,
        includeDirectories: true,
      }),
    ).resolves.toEqual([]);
  });

  it("refreshes a cached directory after a child is created", async () => {
    const dynamicRoot = path.join(searchRoot, "dynamic-cache-root");
    mkdirSync(dynamicRoot);

    await expect(
      searchDirectoryEntries({
        root: dynamicRoot,
        query: "fresh-project",
        pathFormat: "relative",
        includeFiles: false,
        includeDirectories: true,
      }),
    ).resolves.toEqual([]);

    mkdirSync(path.join(dynamicRoot, "fresh-project"));

    await expect(
      searchDirectoryEntries({
        root: dynamicRoot,
        query: "fresh-project",
        pathFormat: "relative",
        includeFiles: false,
        includeDirectories: true,
      }),
    ).resolves.toEqual([{ path: "fresh-project", kind: "directory" }]);
  });
});

describe("absolute directory-path configuration", () => {
  let tempRoot: string;
  let homeDir: string;
  let outsideDir: string;

  beforeEach(() => {
    tempRoot = realpathSync.native(mkdtempSync(path.join(tmpdir(), "directory-suggestions-")));
    homeDir = path.join(tempRoot, "home");
    outsideDir = path.join(tempRoot, "outside");

    mkdirSync(homeDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    homeDir = realpathSync.native(homeDir);
    outsideDir = realpathSync.native(outsideDir);

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

  it("does not inspect directories when the scan budget is zero", async () => {
    await expect(
      searchAbsoluteDirectoryPaths({
        homeDir,
        query: "documents",
        limit: 10,
        maxDirectoriesScanned: 0,
      }),
    ).resolves.toEqual([]);
  });

  it("shares the scan budget fairly between nested sibling branches", async () => {
    const budgetHome = path.join(tempRoot, "nested-budget-home");
    const projectPath = path.join(budgetHome, "work", "client", "team", "paseo-desktop");
    mkdirSync(projectPath, { recursive: true });
    for (let index = 0; index < 10; index += 1) {
      mkdirSync(
        path.join(budgetHome, "work", "archive", `noise-${index.toString().padStart(2, "0")}`),
        { recursive: true },
      );
    }

    const results = await searchAbsoluteDirectoryPaths({
      homeDir: budgetHome,
      query: "paseo-desktop",
      limit: 10,
      maxDirectoriesScanned: 8,
    });

    expect(results.map((result) => realpathSync.native(result))).toEqual([
      realpathSync.native(projectPath),
    ]);
  });

  it.skipIf(isWindows)("does not let a queued symlink hide the direct project branch", async () => {
    const symlinkHome = path.join(tempRoot, "symlink-budget-home");
    const projectRoot = path.join(symlinkHome, "b-projects", "project-root");
    const projectPath = path.join(projectRoot, "paseo-desktop");
    const noisyBranch = path.join(symlinkHome, "a-noisy");
    mkdirSync(projectPath, { recursive: true });
    for (let index = 0; index < 10; index += 1) {
      mkdirSync(path.join(noisyBranch, `noise-${index.toString().padStart(2, "0")}`), {
        recursive: true,
      });
    }
    // The alias is intentionally queued behind the noise. Discovery must not
    // reserve its target before the direct b-projects branch gets a turn.
    symlinkSync(projectRoot, path.join(noisyBranch, "zz-target-link"));

    const results = await searchAbsoluteDirectoryPaths({
      homeDir: symlinkHome,
      query: "paseo-desktop",
      limit: 10,
      maxDirectoriesScanned: 6,
    });

    expect(results.map((result) => realpathSync.native(result))).toEqual([
      realpathSync.native(projectPath),
    ]);
  });

  it.skipIf(isWindows)("follows visible directory symlinks that stay inside home", async () => {
    const symlinkHome = path.join(tempRoot, "internal-symlink-home");
    const projectPath = path.join(symlinkHome, ".linked", "project-root", "paseo-desktop");
    mkdirSync(projectPath, { recursive: true });
    symlinkSync(path.dirname(projectPath), path.join(symlinkHome, "linked-project"));

    const results = await searchAbsoluteDirectoryPaths({
      homeDir: symlinkHome,
      query: "pso",
      limit: 10,
    });

    expect(results.map((result) => realpathSync.native(result))).toEqual([
      realpathSync.native(projectPath),
    ]);
  });

  it.skipIf(isWindows)("matches the visible name of a directory symlink", async () => {
    const symlinkHome = path.join(tempRoot, "visible-symlink-home");
    const projectsPath = path.join(symlinkHome, "projects");
    const targetPath = path.join(symlinkHome, "work", "current");
    const visibleProjectPath = path.join(projectsPath, "paseo");
    mkdirSync(projectsPath, { recursive: true });
    mkdirSync(targetPath, { recursive: true });
    symlinkSync(targetPath, visibleProjectPath);

    const results = await searchAbsoluteDirectoryPaths({
      homeDir: symlinkHome,
      query: "paseo",
      limit: 10,
    });

    expect(results).toContain(visibleProjectPath);
  });

  it("keeps scanning past weak fuzzy matches for a stronger late result", async () => {
    const largeHome = path.join(tempRoot, "large-home");
    const exactMatchPath = path.join(largeHome, "pso");
    for (let index = 0; index < 8; index += 1) {
      mkdirSync(
        path.join(largeHome, `a-${index.toString().padStart(2, "0")}-project-search-output`),
        { recursive: true },
      );
    }
    mkdirSync(exactMatchPath);

    const results = await searchDirectoryEntries({
      root: largeHome,
      query: "pso",
      pathFormat: "absolute",
      includeFiles: false,
      includeDirectories: true,
      limit: 1,
      maxEntriesScanned: 20,
      confidentResultScanThreshold: 5,
    });

    expect(results).toEqual([{ path: exactMatchPath, kind: "directory" }]);
  });

  it("supports home-relative path query syntax", async () => {
    const result = await searchAbsoluteDirectoryPaths({
      homeDir,
      query: "~/projects/pa",
      limit: 10,
    });

    expect(result.map((entry) => realpathSync.native(entry))).toEqual([
      realpathSync.native(path.join(homeDir, "projects", "paseo")),
      realpathSync.native(path.join(homeDir, "projects", "playground")),
    ]);
  });

  it("prioritizes partial matches that appear earlier in the path", async () => {
    const earlierPath = path.join(homeDir, "farofoo");
    const laterPath = path.join(homeDir, "x", "y", "farofoo");
    mkdirSync(earlierPath, { recursive: true });
    mkdirSync(laterPath, { recursive: true });

    const results = await searchAbsoluteDirectoryPaths({
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

  // POSIX-only: creates and follows a symlink escape fixture.
  it.skipIf(isWindows)("does not return paths that escape home through symlinks", async () => {
    const results = await searchAbsoluteDirectoryPaths({
      homeDir,
      query: "outside",
      limit: 20,
    });

    expect(results).not.toContain(path.join(homeDir, "outside-link"));
    expect(results).not.toContain(path.join(outsideDir, "outside-match"));
  });

  it("respects the result limit", async () => {
    const results = await searchAbsoluteDirectoryPaths({
      homeDir,
      query: "p",
      limit: 1,
    });

    expect(results).toHaveLength(1);
  });
});

describe("relative typed-entry configuration", () => {
  let tempRoot: string;
  let workspaceDir: string;

  beforeEach(() => {
    tempRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "workspace-suggestions-")));
    workspaceDir = path.join(tempRoot, "workspace");

    mkdirSync(path.join(workspaceDir, "src", "components"), {
      recursive: true,
    });
    mkdirSync(path.join(workspaceDir, "docs"), { recursive: true });

    writeFileSync(path.join(workspaceDir, "README.md"), "# paseo\n");
    writeFileSync(
      path.join(workspaceDir, "src", "components", "chat-input.tsx"),
      "export const ChatInput = null;\n",
    );
    writeFileSync(path.join(workspaceDir, "docs", "notes.md"), "notes\n");
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("ranks fuzzy basename matches after exact, prefix, and substring matches", async () => {
    writeFileSync(path.join(workspaceDir, "src", "components", "msgrndr"), "");
    writeFileSync(path.join(workspaceDir, "src", "components", "msgrndr-panel.tsx"), "");
    writeFileSync(path.join(workspaceDir, "src", "components", "use-msgrndr.ts"), "");
    writeFileSync(path.join(workspaceDir, "src", "components", "message-renderer.tsx"), "");

    const results = await searchRelativeDirectoryEntries({
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

    const basenameResults = await searchRelativeDirectoryEntries({
      cwd: workspaceDir,
      query: "file.ts",
      limit: 20,
      includeFiles: true,
      includeDirectories: false,
      matchMode: "suffix",
    });
    const suffixResults = await searchRelativeDirectoryEntries({
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

    const results = await searchRelativeDirectoryEntries({
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

    const results = await searchRelativeDirectoryEntries({
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

  it("traverses only allowlisted hidden directories without suggesting the directories", async () => {
    mkdirSync(path.join(workspaceDir, ".claude"), { recursive: true });
    mkdirSync(path.join(workspaceDir, ".dev", "cache"), { recursive: true });
    writeFileSync(path.join(workspaceDir, ".claude", "settings.local.json"), "{}");
    writeFileSync(path.join(workspaceDir, ".dev", "cache", "settings.local.json"), "{}");

    const suffixResults = await searchRelativeDirectoryEntries({
      cwd: workspaceDir,
      query: "settings.local.json",
      limit: 20,
      includeFiles: true,
      includeDirectories: true,
      matchMode: "suffix",
    });
    const fuzzyResults = await searchRelativeDirectoryEntries({
      cwd: workspaceDir,
      query: "claude",
      limit: 20,
      includeFiles: true,
      includeDirectories: true,
      matchMode: "fuzzy",
    });

    expect({ suffixResults, fuzzyResults }).toEqual({
      suffixResults: [{ path: ".claude/settings.local.json", kind: "file" }],
      fuzzyResults: [{ path: ".claude/settings.local.json", kind: "file" }],
    });
  });

  it("supports slash-style path queries", async () => {
    const results = await searchRelativeDirectoryEntries({
      cwd: workspaceDir,
      query: "src/co",
      limit: 20,
      includeFiles: true,
      includeDirectories: true,
    });

    expect(results).toEqual([{ path: "src/components", kind: "directory" }]);
  });
});
