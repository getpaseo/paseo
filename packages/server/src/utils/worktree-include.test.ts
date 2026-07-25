import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
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

  it("rejects unsafe, dangling, and conflicting entries before a worktree exists", async () => {
    writeFileSync(join(sourceRoot, ".worktreeinclude"), "../outside\n");
    await expect(readWorktreeIncludePlan({ sourceRoot })).rejects.toThrow(
      "parent-directory segments are not allowed",
    );

    writeFileSync(join(sourceRoot, ".worktreeinclude"), "symlink\n");
    await expect(readWorktreeIncludePlan({ sourceRoot })).rejects.toThrow("requires a path");

    writeFileSync(join(sourceRoot, "shared"), "source\n");
    writeFileSync(
      join(sourceRoot, ".worktreeinclude"),
      ["shared", "symlink shared", ""].join("\n"),
    );
    await expect(readWorktreeIncludePlan({ sourceRoot })).rejects.toThrow(
      "use both copy and symlink modes",
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
  });

  it("rejects directory copies that overlap protected worktree paths", async () => {
    const protectedWorktreeRoot = join(sourceRoot, ".dev", "paseo-home", "worktrees", "project");
    mkdirSync(protectedWorktreeRoot, { recursive: true });
    writeFileSync(join(sourceRoot, ".worktreeinclude"), ".dev/**\n");

    await expect(
      readWorktreeIncludePlan({
        sourceRoot,
        excludedSourceRoots: [protectedWorktreeRoot],
      }),
    ).rejects.toThrow("overlaps with a protected worktree path");
  });

  it.skipIf(isPlatform("win32"))(
    "rejects protected paths reached through a symlink alias",
    async () => {
      const sourceAlias = join(tempDir, "source-alias");
      symlinkSync(sourceRoot, sourceAlias, "dir");
      writeFileSync(join(sourceRoot, ".worktreeinclude"), ".dev/**\n");

      await expect(
        readWorktreeIncludePlan({
          sourceRoot,
          excludedSourceRoots: [join(sourceAlias, ".dev", "paseo-home", "worktrees", "project")],
        }),
      ).rejects.toThrow("overlaps with a protected worktree path");
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

  it("rejects a source symlink", async () => {
    const outsidePath = join(tempDir, "outside.txt");
    writeFileSync(outsidePath, "outside\n");
    symlinkSync(outsidePath, join(sourceRoot, "linked.txt"));
    writeFileSync(join(sourceRoot, ".worktreeinclude"), "linked.txt\n");

    await expect(readWorktreeIncludePlan({ sourceRoot })).rejects.toThrow(
      "resolves through a symbolic link",
    );
  });

  it("skips a source removed after planning", async () => {
    writeFileSync(join(sourceRoot, ".worktreeinclude"), "runtime.env\n");
    const sourcePath = join(sourceRoot, "runtime.env");
    writeFileSync(sourcePath, "source\n");

    const plan = await readWorktreeIncludePlan({ sourceRoot });
    rmSync(sourcePath);

    await materializeWorktreeIncludePlan({ plan, worktreeRoot });

    expect(existsSync(join(worktreeRoot, "runtime.env"))).toBe(false);
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
