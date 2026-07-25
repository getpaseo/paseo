import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  chmodSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, relative } from "path";
import { isPlatform } from "../test-utils/platform.js";
import { materializeWorktreeIncludePlan, readWorktreeIncludePlan } from "./worktree-include.js";

describe("worktree include planning", () => {
  let tempDir: string;
  let sourceRoot: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "worktree-include-test-"));
    sourceRoot = join(tempDir, "source");
    mkdirSync(sourceRoot);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("copies bare entries and accepts explicit copy and symlink modes", async () => {
    writeFileSync(
      join(sourceRoot, ".worktreeinclude"),
      [".env.local", ".cache/**", "symlink shared-state", "copy packages/*/.runtime.env", ""].join(
        "\n",
      ),
    );
    writeFileSync(join(sourceRoot, ".env.local"), "source\n");
    mkdirSync(join(sourceRoot, ".cache"), { recursive: true });
    writeFileSync(join(sourceRoot, ".cache", "state.txt"), "cache\n");
    mkdirSync(join(sourceRoot, "shared-state"), { recursive: true });
    writeFileSync(join(sourceRoot, "shared-state", "state.txt"), "shared\n");
    mkdirSync(join(sourceRoot, "packages", "api"), { recursive: true });
    writeFileSync(join(sourceRoot, "packages", "api", ".runtime.env"), "api\n");

    const plan = await readWorktreeIncludePlan({ sourceRoot });

    expect(plan.materializations).toHaveLength(4);
    expect(plan.materializations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ mode: "copy", relativePath: ".env.local", sourceKind: "file" }),
        expect.objectContaining({ mode: "copy", relativePath: ".cache", sourceKind: "directory" }),
        expect.objectContaining({
          mode: "symlink",
          relativePath: "shared-state",
          sourceKind: "directory",
        }),
        expect.objectContaining({
          mode: "copy",
          relativePath: "packages/api/.runtime.env",
          sourceKind: "file",
        }),
      ]),
    );
  });

  it("skips invalid and conflicting entries while retaining safe entries", async () => {
    writeFileSync(join(sourceRoot, "shared"), "source\n");
    writeFileSync(join(sourceRoot, ".env"), "source\n");
    writeFileSync(
      join(sourceRoot, ".worktreeinclude"),
      ["../outside", "symlink", "shared", "symlink shared", ".env", ""].join("\n"),
    );

    const plan = await readWorktreeIncludePlan({ sourceRoot });

    expect(plan.materializations).toEqual([
      expect.objectContaining({ mode: "copy", relativePath: ".env", sourceKind: "file" }),
    ]);
    expect(plan.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ lineNumber: 1, raw: "../outside", reason: "invalid" }),
        expect.objectContaining({ lineNumber: 2, raw: "symlink", reason: "invalid" }),
        expect.objectContaining({ lineNumber: 3, raw: "shared", reason: "conflict" }),
        expect.objectContaining({ lineNumber: 4, raw: "symlink shared", reason: "conflict" }),
      ]),
    );
  });

  it("skips missing entries while retaining existing literal and glob matches", async () => {
    writeFileSync(
      join(sourceRoot, ".worktreeinclude"),
      [".env", ".env.local", "config/*.env", "missing/**", ""].join("\n"),
    );
    writeFileSync(join(sourceRoot, ".env"), "source\n");
    mkdirSync(join(sourceRoot, "config"), { recursive: true });
    writeFileSync(join(sourceRoot, "config", "runtime.env"), "runtime\n");

    const plan = await readWorktreeIncludePlan({ sourceRoot });

    expect(plan.materializations).toEqual([
      expect.objectContaining({ mode: "copy", relativePath: ".env", sourceKind: "file" }),
      expect.objectContaining({
        mode: "copy",
        relativePath: "config/runtime.env",
        sourceKind: "file",
      }),
    ]);
    expect(plan.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ raw: ".env.local", reason: "missing" }),
        expect.objectContaining({ raw: "missing/**", reason: "missing" }),
      ]),
    );
  });

  it("skips directory copies that overlap protected worktree paths", async () => {
    const protectedWorktreeRoot = join(sourceRoot, ".dev", "paseo-home", "worktrees", "project");
    mkdirSync(protectedWorktreeRoot, { recursive: true });
    writeFileSync(join(sourceRoot, ".worktreeinclude"), ".dev/**\n");

    const plan = await readWorktreeIncludePlan({
      sourceRoot,
      excludedSourceRoots: [protectedWorktreeRoot],
    });

    expect(plan.materializations).toEqual([]);
    expect(plan.skipped).toEqual([expect.objectContaining({ raw: ".dev/**", reason: "unsafe" })]);
  });

  it.skipIf(isPlatform("win32"))(
    "skips protected paths reached through a symlink alias",
    async () => {
      const sourceAlias = join(tempDir, "source-alias");
      symlinkSync(sourceRoot, sourceAlias, "dir");
      mkdirSync(join(sourceRoot, ".dev", "paseo-home", "worktrees", "project"), {
        recursive: true,
      });
      writeFileSync(join(sourceRoot, ".worktreeinclude"), ".dev/**\n");

      const plan = await readWorktreeIncludePlan({
        sourceRoot,
        excludedSourceRoots: [join(sourceAlias, ".dev", "paseo-home", "worktrees", "project")],
      });

      expect(plan.materializations).toEqual([]);
      expect(plan.skipped).toEqual([expect.objectContaining({ raw: ".dev/**", reason: "unsafe" })]);
    },
  );

  it.skipIf(isPlatform("win32"))(
    "skips external source links while retaining safe entries",
    async () => {
      const outsidePath = join(tempDir, "outside.txt");
      writeFileSync(outsidePath, "outside\n");
      writeFileSync(join(sourceRoot, "safe.txt"), "safe\n");
      symlinkSync(outsidePath, join(sourceRoot, "linked.txt"));
      writeFileSync(
        join(sourceRoot, ".worktreeinclude"),
        ["safe.txt", "linked.txt", ""].join("\n"),
      );

      const plan = await readWorktreeIncludePlan({ sourceRoot });

      expect(plan.materializations).toEqual([
        expect.objectContaining({ relativePath: "safe.txt", sourceKind: "file" }),
      ]);
      expect(plan.skipped).toEqual([
        expect.objectContaining({ raw: "linked.txt", reason: "unsafe" }),
      ]);
    },
  );

  it.skipIf(isPlatform("win32"))(
    "does not scan unrelated directories for bounded globs",
    async () => {
      writeFileSync(join(sourceRoot, ".worktreeinclude"), "packages/*/.runtime.env\n");
      mkdirSync(join(sourceRoot, "packages", "api"), { recursive: true });
      writeFileSync(join(sourceRoot, "packages", "api", ".runtime.env"), "api\n");
      const unreadableDirectory = join(sourceRoot, "unrelated");
      mkdirSync(unreadableDirectory);
      chmodSync(unreadableDirectory, 0o000);

      try {
        const plan = await readWorktreeIncludePlan({ sourceRoot });
        expect(plan.materializations).toEqual([
          expect.objectContaining({ relativePath: "packages/api/.runtime.env" }),
        ]);
      } finally {
        chmodSync(unreadableDirectory, 0o700);
      }
    },
  );
});

describe.skipIf(isPlatform("win32"))("worktree include materialization", () => {
  let tempDir: string;
  let sourceRoot: string;
  let worktreeRoot: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "worktree-include-materialize-test-"));
    sourceRoot = join(tempDir, "source");
    worktreeRoot = join(tempDir, "worktree");
    mkdirSync(sourceRoot);
    mkdirSync(worktreeRoot);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("copies snapshots, links shared paths, and is idempotent", async () => {
    writeFileSync(
      join(sourceRoot, ".worktreeinclude"),
      ["copy.txt", "copy-dir/**", "symlink linked.txt", "symlink linked-dir"].join("\n"),
    );
    writeFileSync(join(sourceRoot, "copy.txt"), "copy-v1\n");
    mkdirSync(join(sourceRoot, "copy-dir"), { recursive: true });
    writeFileSync(join(sourceRoot, "copy-dir", "state.txt"), "copy-dir-v1\n");
    writeFileSync(join(sourceRoot, "linked.txt"), "linked-v1\n");
    mkdirSync(join(sourceRoot, "linked-dir"), { recursive: true });
    writeFileSync(join(sourceRoot, "linked-dir", "state.txt"), "linked-dir-v1\n");

    const plan = await readWorktreeIncludePlan({ sourceRoot });
    await materializeWorktreeIncludePlan({ plan, worktreeRoot });

    expect(lstatSync(join(worktreeRoot, "copy.txt")).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(worktreeRoot, "copy-dir")).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(worktreeRoot, "linked.txt")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(worktreeRoot, "linked-dir")).isSymbolicLink()).toBe(true);

    writeFileSync(join(sourceRoot, "copy.txt"), "copy-v2\n");
    writeFileSync(join(sourceRoot, "copy-dir", "state.txt"), "copy-dir-v2\n");
    writeFileSync(join(sourceRoot, "linked.txt"), "linked-v2\n");
    writeFileSync(join(sourceRoot, "linked-dir", "state.txt"), "linked-dir-v2\n");

    expect(readFileSync(join(worktreeRoot, "copy.txt"), "utf8")).toBe("copy-v1\n");
    expect(readFileSync(join(worktreeRoot, "copy-dir", "state.txt"), "utf8")).toBe("copy-dir-v1\n");
    expect(readFileSync(join(worktreeRoot, "linked.txt"), "utf8")).toBe("linked-v2\n");
    expect(readFileSync(join(worktreeRoot, "linked-dir", "state.txt"), "utf8")).toBe(
      "linked-dir-v2\n",
    );

    await materializeWorktreeIncludePlan({ plan, worktreeRoot });
    expect(readFileSync(join(worktreeRoot, "copy.txt"), "utf8")).toBe("copy-v2\n");
    expect(readFileSync(join(worktreeRoot, "copy-dir", "state.txt"), "utf8")).toBe("copy-dir-v2\n");
  });

  it("rejects a destination parent symlink without writing through it", async () => {
    mkdirSync(join(sourceRoot, "config"), { recursive: true });
    writeFileSync(join(sourceRoot, "config", "local.json"), "{}\n");
    writeFileSync(join(sourceRoot, ".worktreeinclude"), "config/local.json\n");

    const outsideRoot = join(tempDir, "outside");
    mkdirSync(outsideRoot);
    symlinkSync(outsideRoot, join(worktreeRoot, "config"));

    const plan = await readWorktreeIncludePlan({ sourceRoot });
    await expect(materializeWorktreeIncludePlan({ plan, worktreeRoot })).rejects.toThrow(
      "Refusing to materialize .worktreeinclude entry",
    );
    expect(existsSync(join(outsideRoot, "local.json"))).toBe(false);
  });

  it("copies resolved source links and creates direct live links", async () => {
    const targetPath = join(sourceRoot, "target.txt");
    const targetDirectoryPath = join(sourceRoot, "target-directory");
    writeFileSync(targetPath, "v1\n");
    mkdirSync(targetDirectoryPath);
    writeFileSync(join(targetDirectoryPath, "state.txt"), "v1\n");
    symlinkSync(targetPath, join(sourceRoot, "copy-link.txt"));
    symlinkSync(targetPath, join(sourceRoot, "live-link.txt"));
    symlinkSync(targetDirectoryPath, join(sourceRoot, "copy-directory-link"), "dir");
    symlinkSync(targetDirectoryPath, join(sourceRoot, "live-directory-link"), "dir");
    writeFileSync(
      join(sourceRoot, ".worktreeinclude"),
      [
        "copy-link.txt",
        "symlink live-link.txt",
        "copy-directory-link",
        "symlink live-directory-link",
        "",
      ].join("\n"),
    );

    const plan = await readWorktreeIncludePlan({ sourceRoot });
    const result = await materializeWorktreeIncludePlan({ plan, worktreeRoot });

    const copiedPath = join(worktreeRoot, "copy-link.txt");
    const linkedPath = join(worktreeRoot, "live-link.txt");
    const copiedDirectoryPath = join(worktreeRoot, "copy-directory-link");
    const linkedDirectoryPath = join(worktreeRoot, "live-directory-link");
    const canonicalWorktreeRoot = realpathSync(worktreeRoot);
    expect(result).toMatchObject({ materialized: 4, skipped: [] });
    expect(lstatSync(copiedPath).isSymbolicLink()).toBe(false);
    expect(lstatSync(linkedPath).isSymbolicLink()).toBe(true);
    expect(lstatSync(copiedDirectoryPath).isSymbolicLink()).toBe(false);
    expect(lstatSync(linkedDirectoryPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linkedPath)).toBe(
      relative(dirname(join(canonicalWorktreeRoot, "live-link.txt")), realpathSync(targetPath)),
    );
    expect(readlinkSync(linkedDirectoryPath)).toBe(
      relative(
        dirname(join(canonicalWorktreeRoot, "live-directory-link")),
        realpathSync(targetDirectoryPath),
      ),
    );
    expect(realpathSync(linkedPath)).toBe(realpathSync(targetPath));
    expect(realpathSync(linkedDirectoryPath)).toBe(realpathSync(targetDirectoryPath));

    writeFileSync(targetPath, "v2\n");
    writeFileSync(join(targetDirectoryPath, "state.txt"), "v2\n");
    expect(readFileSync(copiedPath, "utf8")).toBe("v1\n");
    expect(readFileSync(linkedPath, "utf8")).toBe("v2\n");
    expect(readFileSync(join(copiedDirectoryPath, "state.txt"), "utf8")).toBe("v1\n");
    expect(readFileSync(join(linkedDirectoryPath, "state.txt"), "utf8")).toBe("v2\n");
  });

  it("treats hard links as ordinary files", async () => {
    const targetPath = join(sourceRoot, "target.txt");
    const hardLinkPath = join(sourceRoot, "hard-link.txt");
    writeFileSync(targetPath, "v1\n");
    linkSync(targetPath, hardLinkPath);
    writeFileSync(join(sourceRoot, ".worktreeinclude"), "hard-link.txt\n");

    const plan = await readWorktreeIncludePlan({ sourceRoot });
    await materializeWorktreeIncludePlan({ plan, worktreeRoot });

    const copiedPath = join(worktreeRoot, "hard-link.txt");
    expect(lstatSync(copiedPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(copiedPath, "utf8")).toBe("v1\n");
  });

  it("skips a source link retargeted outside the checkout after planning", async () => {
    const insidePath = join(sourceRoot, "inside.txt");
    const linkedPath = join(sourceRoot, "linked.txt");
    const outsidePath = join(tempDir, "outside.txt");
    writeFileSync(insidePath, "inside\n");
    writeFileSync(outsidePath, "outside\n");
    symlinkSync(insidePath, linkedPath);
    writeFileSync(join(sourceRoot, ".worktreeinclude"), "symlink linked.txt\n");

    const plan = await readWorktreeIncludePlan({ sourceRoot });
    rmSync(linkedPath);
    symlinkSync(outsidePath, linkedPath);

    const result = await materializeWorktreeIncludePlan({ plan, worktreeRoot });

    expect(existsSync(join(worktreeRoot, "linked.txt"))).toBe(false);
    expect(result.skipped).toEqual([
      expect.objectContaining({ raw: "symlink linked.txt", reason: "unsafe" }),
    ]);
  });

  it("skips a linked directory that exposes an external nested link", async () => {
    const sharedPath = join(sourceRoot, "shared");
    const outsidePath = join(tempDir, "outside.txt");
    mkdirSync(sharedPath);
    writeFileSync(outsidePath, "outside\n");
    symlinkSync(outsidePath, join(sharedPath, "outside.txt"));
    writeFileSync(join(sourceRoot, ".worktreeinclude"), "symlink shared\n");

    const plan = await readWorktreeIncludePlan({ sourceRoot });

    expect(plan.materializations).toEqual([]);
    expect(plan.skipped).toEqual([
      expect.objectContaining({ raw: "symlink shared", reason: "unsafe" }),
    ]);
  });

  it("allows a linked directory with internal nested links", async () => {
    const sharedPath = join(sourceRoot, "shared");
    const targetPath = join(sourceRoot, "shared-target");
    mkdirSync(sharedPath);
    mkdirSync(targetPath);
    writeFileSync(join(targetPath, "state.txt"), "source\n");
    symlinkSync(targetPath, join(sharedPath, "target"), "dir");
    writeFileSync(join(sourceRoot, ".worktreeinclude"), "symlink shared\n");

    const plan = await readWorktreeIncludePlan({ sourceRoot });
    const result = await materializeWorktreeIncludePlan({ plan, worktreeRoot });

    expect(result).toMatchObject({ materialized: 1, skipped: [] });
    expect(readFileSync(join(worktreeRoot, "shared", "target", "state.txt"), "utf8")).toBe(
      "source\n",
    );
  });

  it("skips a source removed after planning", async () => {
    writeFileSync(join(sourceRoot, ".worktreeinclude"), "runtime.env\n");
    const sourcePath = join(sourceRoot, "runtime.env");
    writeFileSync(sourcePath, "source\n");

    const plan = await readWorktreeIncludePlan({ sourceRoot });
    rmSync(sourcePath);

    const result = await materializeWorktreeIncludePlan({ plan, worktreeRoot });

    expect(existsSync(join(worktreeRoot, "runtime.env"))).toBe(false);
    expect(result.skipped).toEqual([
      expect.objectContaining({ raw: "runtime.env", reason: "missing" }),
    ]);
  });
});

describe.skipIf(!isPlatform("win32"))("worktree include Windows directory links", () => {
  let tempDir: string;
  let sourceRoot: string;
  let worktreeRoot: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "worktree-include-windows-test-"));
    sourceRoot = join(tempDir, "source");
    worktreeRoot = join(tempDir, "worktree");
    mkdirSync(sourceRoot);
    mkdirSync(worktreeRoot);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("uses a live directory link and removes it without touching the source", async () => {
    mkdirSync(join(sourceRoot, "shared-state"));
    writeFileSync(join(sourceRoot, "shared-state", "state.txt"), "source-v1\n");
    writeFileSync(join(sourceRoot, ".worktreeinclude"), "symlink shared-state\n");

    const plan = await readWorktreeIncludePlan({ sourceRoot });
    await materializeWorktreeIncludePlan({ plan, worktreeRoot });

    writeFileSync(join(sourceRoot, "shared-state", "state.txt"), "source-v2\n");
    expect(readFileSync(join(worktreeRoot, "shared-state", "state.txt"), "utf8")).toBe(
      "source-v2\n",
    );

    rmSync(worktreeRoot, { recursive: true, force: true });
    expect(readFileSync(join(sourceRoot, "shared-state", "state.txt"), "utf8")).toBe("source-v2\n");
  });
});
