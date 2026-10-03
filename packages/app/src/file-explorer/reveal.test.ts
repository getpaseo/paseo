import { describe, expect, it, vi } from "vitest";
import type { ExplorerDirectory, ExplorerEntry } from "@/stores/session-store";
import type { ExplorerListRow } from "./tree";
import {
  EXPLORER_REVEAL_REQUEST_TTL_MS,
  buildExplorerRevealKey,
  clearExplorerRevealRequest,
  explorerAncestorPaths,
  findExplorerListRowIndex,
  isExplorerRevealRequestExpired,
  planExplorerReveal,
  replaceExplorerRevealRequest,
  resolveExplorerRevealPath,
  runExplorerReveal,
  settleExplorerTreeRestore,
  type ExplorerRevealPlan,
} from "./reveal";

function entry(path: string, kind: ExplorerEntry["kind"]): ExplorerEntry {
  return {
    name: path.split("/").at(-1) ?? path,
    path,
    kind,
    size: 0,
    modifiedAt: "2026-01-01T00:00:00.000Z",
  };
}

function directory(path: string, entries: ExplorerEntry[]): ExplorerDirectory {
  return { path, entries };
}

const TREE: ReadonlyMap<string, ExplorerDirectory> = new Map([
  [".", directory(".", [entry("src", "directory"), entry("README.md", "file")])],
  ["src", directory("src", [entry("src/app", "directory"), entry("src/index.ts", "file")])],
  ["src/app", directory("src/app", [entry("src/app/main.ts", "file")])],
]);

interface RevealHarness {
  listed: string[];
  expanded: string[];
  run: (plan: ExplorerRevealPlan) => ReturnType<typeof runExplorerReveal>;
}

interface HarnessInput {
  cachedPaths: string[];
  /** Cached listings taken before the filesystem changed; they win over `cachedPaths`. */
  staleListings?: ExplorerDirectory[];
  /** What a fresh listing returns; defaults to `TREE`. */
  tree?: ReadonlyMap<string, ExplorerDirectory>;
  failingPath?: string;
}

function createHarness(input: HarnessInput): RevealHarness {
  const tree = input.tree ?? TREE;
  const cached = new Map<string, ExplorerDirectory>();
  for (const path of input.cachedPaths) {
    const cachedDirectory = tree.get(path);
    if (cachedDirectory) cached.set(path, cachedDirectory);
  }
  for (const stale of input.staleListings ?? []) {
    cached.set(stale.path, stale);
  }
  const listed: string[] = [];
  const expanded: string[] = [];
  function run(plan: ExplorerRevealPlan) {
    return runExplorerReveal({
      plan,
      getDirectory: (path) => cached.get(path),
      requestDirectoryListing: async (path) => {
        listed.push(path);
        if (path === input.failingPath) return null;
        return tree.get(path) ?? null;
      },
      expandDirectory: (path) => {
        expanded.push(path);
      },
      isCurrent: () => true,
    });
  }
  return { listed, expanded, run };
}

describe("explorerAncestorPaths", () => {
  it("returns no ancestors for the root or a root-level entry", () => {
    expect(explorerAncestorPaths(".")).toEqual([]);
    expect(explorerAncestorPaths("README.md")).toEqual([]);
  });

  it("lists every ancestor directory from the root down", () => {
    expect(explorerAncestorPaths("src/app/main.ts")).toEqual(["src", "src/app"]);
  });
});

describe("resolveExplorerRevealPath", () => {
  it("keeps a workspace-relative path in tree form", () => {
    expect(resolveExplorerRevealPath({ path: "src/app/main.ts", workspaceRoot: "/repo" })).toBe(
      "src/app/main.ts",
    );
  });

  it("normalizes dot segments in a relative path", () => {
    expect(resolveExplorerRevealPath({ path: "./src/../README.md", workspaceRoot: "/repo" })).toBe(
      "README.md",
    );
  });

  it("converts an absolute path inside the workspace", () => {
    expect(resolveExplorerRevealPath({ path: "/repo/src/index.ts", workspaceRoot: "/repo/" })).toBe(
      "src/index.ts",
    );
  });

  it("converts a Windows path case-insensitively", () => {
    expect(
      resolveExplorerRevealPath({ path: "C:\\Repo\\src\\index.ts", workspaceRoot: "c:/repo" }),
    ).toBe("src/index.ts");
  });

  it("rejects paths outside the workspace root", () => {
    expect(
      resolveExplorerRevealPath({ path: "/other/file.ts", workspaceRoot: "/repo" }),
    ).toBeNull();
    expect(resolveExplorerRevealPath({ path: "/repository/a.ts", workspaceRoot: "/repo" })).toBe(
      null,
    );
    expect(resolveExplorerRevealPath({ path: "../escape.ts", workspaceRoot: "/repo" })).toBeNull();
    expect(resolveExplorerRevealPath({ path: "~/notes.md", workspaceRoot: "/repo" })).toBeNull();
    expect(resolveExplorerRevealPath({ path: "/repo", workspaceRoot: "/repo" })).toBeNull();
  });
});

describe("planExplorerReveal", () => {
  it("expands every ancestor and selects the target when it is visible", () => {
    expect(planExplorerReveal({ path: "src/app/main.ts", showHiddenFiles: false })).toEqual({
      path: "src/app/main.ts",
      ancestors: ["src", "src/app"],
      selectPath: "src/app/main.ts",
      isHidden: false,
    });
  });

  it("stops at the first hidden segment and selects the deepest visible ancestor", () => {
    expect(planExplorerReveal({ path: "src/.cache/out/file.js", showHiddenFiles: false })).toEqual({
      path: "src/.cache/out/file.js",
      ancestors: ["src"],
      selectPath: "src",
      isHidden: true,
    });
  });

  it("selects nothing when the hidden entry sits at the root", () => {
    expect(planExplorerReveal({ path: ".env", showHiddenFiles: false })).toEqual({
      path: ".env",
      ancestors: [],
      selectPath: null,
      isHidden: true,
    });
  });

  it("reveals hidden paths normally when hidden files are shown", () => {
    expect(planExplorerReveal({ path: ".github/ci.yml", showHiddenFiles: true })).toEqual({
      path: ".github/ci.yml",
      ancestors: [".github"],
      selectPath: ".github/ci.yml",
      isHidden: false,
    });
  });
});

describe("findExplorerListRowIndex", () => {
  const rows: ExplorerListRow[] = [
    { type: "entry", row: { entry: entry("src", "directory"), depth: 0 } },
    { type: "draft", parentPath: "src", kind: "file", depth: 1 },
    { type: "entry", row: { entry: entry("src/index.ts", "file"), depth: 1 } },
    { type: "rename", entry: entry("README.md", "file"), depth: 0 },
  ];

  it("finds entry rows past inserted draft rows", () => {
    expect(findExplorerListRowIndex(rows, "src/index.ts")).toBe(2);
  });

  it("finds a row that is being renamed", () => {
    expect(findExplorerListRowIndex(rows, "README.md")).toBe(3);
  });

  it("returns -1 when the row is not rendered", () => {
    expect(findExplorerListRowIndex(rows, "src/app/main.ts")).toBe(-1);
  });
});

describe("reveal requests", () => {
  const key = buildExplorerRevealKey({ serverId: "server-1", workspaceStateKey: "workspace:ws" });

  it("replaces an older request for the same workspace", () => {
    const first = replaceExplorerRevealRequest({}, key, {
      path: "a.ts",
      requestId: 1,
      createdAt: 0,
    });
    const second = replaceExplorerRevealRequest(first, key, {
      path: "b.ts",
      requestId: 2,
      createdAt: 0,
    });
    expect(second).toEqual({ [key]: { path: "b.ts", requestId: 2, createdAt: 0 } });
    expect(first).toEqual({ [key]: { path: "a.ts", requestId: 1, createdAt: 0 } });
  });

  it("keeps requests for other workspaces", () => {
    const otherKey = buildExplorerRevealKey({
      serverId: "server-2",
      workspaceStateKey: "workspace:ws",
    });
    const requests = replaceExplorerRevealRequest({}, otherKey, {
      path: "x.ts",
      requestId: 1,
      createdAt: 0,
    });
    expect(
      replaceExplorerRevealRequest(requests, key, { path: "a.ts", requestId: 2, createdAt: 0 }),
    ).toEqual({
      [otherKey]: { path: "x.ts", requestId: 1, createdAt: 0 },
      [key]: { path: "a.ts", requestId: 2, createdAt: 0 },
    });
  });

  it("clears only the request that finished", () => {
    const requests = replaceExplorerRevealRequest({}, key, {
      path: "b.ts",
      requestId: 2,
      createdAt: 0,
    });
    expect(clearExplorerRevealRequest(requests, key, 1)).toBe(requests);
    expect(clearExplorerRevealRequest(requests, key, 2)).toEqual({});
  });
});

describe("isExplorerRevealRequestExpired", () => {
  const request = { path: "a.ts", requestId: 1, createdAt: 1_000 };

  it("keeps a request within the time limit", () => {
    expect(isExplorerRevealRequestExpired(request, 1_000 + EXPLORER_REVEAL_REQUEST_TTL_MS)).toBe(
      false,
    );
  });

  it("expires a request past the time limit", () => {
    expect(
      isExplorerRevealRequestExpired(request, 1_000 + EXPLORER_REVEAL_REQUEST_TTL_MS + 1),
    ).toBe(true);
  });
});

describe("runExplorerReveal", () => {
  it("loads uncached ancestors in order from the root down", async () => {
    const harness = createHarness({ cachedPaths: ["."] });
    const result = await harness.run(
      planExplorerReveal({ path: "src/app/main.ts", showHiddenFiles: false }),
    );
    expect(result).toBe("revealed");
    expect(harness.listed).toEqual(["src", "src/app"]);
    expect(harness.expanded).toEqual(["src", "src/app"]);
  });

  it("reuses cached listings", async () => {
    const harness = createHarness({ cachedPaths: [".", "src", "src/app"] });
    const result = await harness.run(
      planExplorerReveal({ path: "src/app/main.ts", showHiddenFiles: false }),
    );
    expect(result).toBe("revealed");
    expect(harness.listed).toEqual([]);
    expect(harness.expanded).toEqual(["src", "src/app"]);
  });

  it("reveals a root-level file without listing anything", async () => {
    const harness = createHarness({ cachedPaths: ["."] });
    const result = await harness.run(
      planExplorerReveal({ path: "README.md", showHiddenFiles: false }),
    );
    expect(result).toBe("revealed");
    expect(harness.listed).toEqual([]);
    expect(harness.expanded).toEqual([]);
  });

  it("stops at the first ancestor whose listing fails", async () => {
    const harness = createHarness({ cachedPaths: ["."], failingPath: "src" });
    const result = await harness.run(
      planExplorerReveal({ path: "src/app/main.ts", showHiddenFiles: false }),
    );
    expect(result).toBe("listing-failed");
    expect(harness.listed).toEqual(["src"]);
    expect(harness.expanded).toEqual(["src"]);
  });

  it("re-lists a cached parent once before reporting a missing ancestor", async () => {
    const harness = createHarness({ cachedPaths: ["."] });
    const result = await harness.run(
      planExplorerReveal({ path: "gone/file.ts", showHiddenFiles: false }),
    );
    expect(result).toBe("not-found");
    expect(harness.listed).toEqual(["."]);
    expect(harness.expanded).toEqual([]);
  });

  it("reports a missing file without re-listing a directory it just listed", async () => {
    const harness = createHarness({ cachedPaths: ["."] });
    const result = await harness.run(
      planExplorerReveal({ path: "src/deleted.ts", showHiddenFiles: false }),
    );
    expect(result).toBe("not-found");
    expect(harness.listed).toEqual(["src"]);
    expect(harness.expanded).toEqual(["src"]);
  });

  it("finds a file created after its directory was listed", async () => {
    const harness = createHarness({
      cachedPaths: ["."],
      staleListings: [directory("src", [entry("src/index.ts", "file")])],
      tree: new Map([
        ...TREE,
        ["src", directory("src", [entry("src/index.ts", "file"), entry("src/new.ts", "file")])],
      ]),
    });
    const result = await harness.run(
      planExplorerReveal({ path: "src/new.ts", showHiddenFiles: false }),
    );
    expect(result).toBe("revealed");
    expect(harness.listed).toEqual(["src"]);
    expect(harness.expanded).toEqual(["src"]);
  });

  it("finds a directory created after its parent was listed", async () => {
    const harness = createHarness({
      cachedPaths: ["."],
      staleListings: [directory(".", [entry("README.md", "file")])],
      tree: new Map([
        [".", directory(".", [entry("README.md", "file"), entry("lib", "directory")])],
        ["lib", directory("lib", [entry("lib/util.ts", "file")])],
      ]),
    });
    const result = await harness.run(
      planExplorerReveal({ path: "lib/util.ts", showHiddenFiles: false }),
    );
    expect(result).toBe("revealed");
    expect(harness.listed).toEqual([".", "lib"]);
    expect(harness.expanded).toEqual(["lib"]);
  });

  it("reports a file still missing after a fresh listing, re-listing once per level", async () => {
    const harness = createHarness({ cachedPaths: [".", "src"] });
    const result = await harness.run(
      planExplorerReveal({ path: "src/missing.ts", showHiddenFiles: false }),
    );
    expect(result).toBe("not-found");
    expect(harness.listed).toEqual(["src"]);
  });

  it("stops when re-listing a stale parent fails", async () => {
    const harness = createHarness({
      cachedPaths: ["."],
      staleListings: [directory("src", [])],
      failingPath: "src",
    });
    const result = await harness.run(
      planExplorerReveal({ path: "src/index.ts", showHiddenFiles: false }),
    );
    expect(result).toBe("listing-failed");
    expect(harness.listed).toEqual(["src"]);
  });

  it("expands visible ancestors of a hidden target and reports it hidden", async () => {
    const harness = createHarness({ cachedPaths: ["."] });
    const result = await harness.run(
      planExplorerReveal({ path: "src/.cache/file.js", showHiddenFiles: false }),
    );
    expect(result).toBe("hidden");
    expect(harness.expanded).toEqual(["src"]);
  });

  it("stops when a newer request replaces it mid-flight", async () => {
    let isCurrent = true;
    const expandDirectory = vi.fn();
    const result = await runExplorerReveal({
      plan: planExplorerReveal({ path: "src/app/main.ts", showHiddenFiles: false }),
      getDirectory: (path) => (path === "." ? TREE.get(".") : undefined),
      requestDirectoryListing: async (path) => {
        isCurrent = false;
        return TREE.get(path) ?? null;
      },
      expandDirectory,
      isCurrent: () => isCurrent,
    });
    expect(result).toBe("superseded");
    expect(expandDirectory).toHaveBeenCalledTimes(1);
    expect(expandDirectory).toHaveBeenCalledWith("src");
  });
});

describe("settleExplorerTreeRestore", () => {
  function settle(restore: Promise<string | null>, isCurrentAttempt = true) {
    const onSettled = vi.fn();
    const settled = settleExplorerTreeRestore({
      restore,
      attemptKey: "ws-a",
      isCurrentAttempt: () => isCurrentAttempt,
      onSettled,
    });
    return { settled, onSettled };
  }

  it("reports the workspace once its restore finished", async () => {
    const { settled, onSettled } = settle(Promise.resolve("ws-a"));
    await settled;
    expect(onSettled).toHaveBeenCalledWith("ws-a");
  });

  it("reports nothing when the call restored nothing, since a later run retries", async () => {
    const { settled, onSettled } = settle(Promise.resolve(null));
    await settled;
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("still reports a restore that threw, then rethrows its error", async () => {
    const failure = new Error("restore failed");
    const { settled, onSettled } = settle(Promise.reject(failure));
    await expect(settled).rejects.toBe(failure);
    expect(onSettled).toHaveBeenCalledWith("ws-a");
  });

  it("ignores a restore that lands after the tree moved to another workspace", async () => {
    const { settled, onSettled } = settle(Promise.resolve("ws-a"), false);
    await settled;
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("ignores a stale restore of the same workspace while a newer one is still running", async () => {
    // A -> B -> A: the first A restore lands while the second A restore is still rewriting the
    // expanded set. The keys match; only the attempt tells them apart.
    let currentAttempt = 1;
    const onSettled = vi.fn();
    let finishFirst: (key: string) => void = () => {};
    let finishSecond: (key: string) => void = () => {};
    const start = (restore: Promise<string>) => {
      const attempt = currentAttempt;
      return settleExplorerTreeRestore({
        restore,
        attemptKey: "ws-a",
        isCurrentAttempt: () => attempt === currentAttempt,
        onSettled,
      });
    };
    const first = start(new Promise((resolve) => (finishFirst = resolve)));
    currentAttempt = 2; // workspace B
    currentAttempt = 3; // back to A
    const second = start(new Promise((resolve) => (finishSecond = resolve)));

    finishFirst("ws-a");
    await first;
    expect(onSettled).not.toHaveBeenCalled();

    finishSecond("ws-a");
    await second;
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith("ws-a");
  });

  it("ignores a stale restore that threw, still rethrowing its error", async () => {
    const failure = new Error("restore failed");
    const { settled, onSettled } = settle(Promise.reject(failure), false);
    await expect(settled).rejects.toBe(failure);
    expect(onSettled).not.toHaveBeenCalled();
  });
});
