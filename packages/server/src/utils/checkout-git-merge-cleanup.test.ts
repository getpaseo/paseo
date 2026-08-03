import { execFileSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type GitFailureMode =
  | "none"
  | "abort"
  | "abort-noop"
  | "generic-cleanup"
  | "generic-restore"
  | "restore"
  | "restore-noop";

function resolveRealGitPath(): string {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, "git");
    if (!existsSync(candidate)) continue;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking for an executable Git binary.
    }
  }
  throw new Error("Unable to find Git for merge cleanup tests");
}

const realGitPath = resolveRealGitPath();

function createMergeRepository(conflicting: boolean): string {
  const repoDir = mkdtempSync(join(tmpdir(), "checkout-merge-cleanup-"));
  execFileSync(realGitPath, ["init", "-b", "main"], { cwd: repoDir });
  execFileSync(realGitPath, ["config", "user.email", "test@example.com"], { cwd: repoDir });
  execFileSync(realGitPath, ["config", "user.name", "Test"], { cwd: repoDir });
  execFileSync(realGitPath, ["config", "commit.gpgsign", "false"], { cwd: repoDir });
  writeFileSync(join(repoDir, "base.txt"), "base\n");
  if (conflicting) {
    writeFileSync(join(repoDir, "conflict.txt"), "base\n");
  }
  execFileSync(realGitPath, ["add", "."], { cwd: repoDir });
  execFileSync(realGitPath, ["commit", "-m", "base"], { cwd: repoDir });
  execFileSync(realGitPath, ["checkout", "-b", "feature"], { cwd: repoDir });
  if (conflicting) {
    writeFileSync(join(repoDir, "conflict.txt"), "feature\n");
    execFileSync(realGitPath, ["commit", "-am", "feature"], { cwd: repoDir });
    execFileSync(realGitPath, ["checkout", "main"], { cwd: repoDir });
    writeFileSync(join(repoDir, "conflict.txt"), "main\n");
    execFileSync(realGitPath, ["commit", "-am", "main"], { cwd: repoDir });
  } else {
    writeFileSync(join(repoDir, "feature.txt"), "feature\n");
    execFileSync(realGitPath, ["add", "feature.txt"], { cwd: repoDir });
    execFileSync(realGitPath, ["commit", "-m", "feature"], { cwd: repoDir });
  }
  execFileSync(realGitPath, ["checkout", "feature"], { cwd: repoDir });
  return repoDir;
}

// runGitCommand spawns `git -c core.quotepath=false <subcommand> ...`, so the
// wrapper sees the subcommand as $3 and its first argument as $4.
function installGitFailureWrapper(mode: GitFailureMode): string {
  const binDir = mkdtempSync(join(tmpdir(), "checkout-git-wrapper-"));
  const wrapperPath = join(binDir, "git");
  const quotedGitPath = realGitPath.replaceAll("'", "'\\''");
  writeFileSync(
    wrapperPath,
    `#!/bin/sh
if [ "$PASEO_TEST_GIT_FAILURE" = "abort" ] && [ "$3" = "merge" ] && [ "$4" = "--abort" ]; then
  echo "abort blocked" >&2
  exit 74
fi
if [ "$PASEO_TEST_GIT_FAILURE" = "abort-noop" ] && [ "$3" = "merge" ] && [ "$4" = "--abort" ]; then
  exit 0
fi
if [ "$PASEO_TEST_GIT_FAILURE" = "generic-cleanup" ] && [ "$3" = "merge" ] && [ "$4" = "feature" ]; then
  echo "generic merge blocked" >&2
  exit 76
fi
if [ "$PASEO_TEST_GIT_FAILURE" = "generic-cleanup" ] && [ "$3" = "merge" ] && [ "$4" = "--abort" ]; then
  echo "generic cleanup blocked" >&2
  exit 77
fi
if [ "$PASEO_TEST_GIT_FAILURE" = "generic-restore" ] && [ "$3" = "checkout" ] && [ "$4" = "main" ]; then
  echo "generic checkout blocked" >&2
  exit 78
fi
if [ "$PASEO_TEST_GIT_FAILURE" = "generic-restore" ] && [ "$3" = "checkout" ] && [ "$4" = "feature" ]; then
  echo "generic restore blocked" >&2
  exit 79
fi
if [ "$PASEO_TEST_GIT_FAILURE" = "restore" ] && [ "$3" = "checkout" ] && [ "$4" = "feature" ]; then
  echo "restore blocked" >&2
  exit 75
fi
if [ "$PASEO_TEST_GIT_FAILURE" = "restore-noop" ] && [ "$3" = "checkout" ] && [ "$4" = "feature" ]; then
  exit 0
fi
exec '${quotedGitPath}' "$@"
`,
  );
  chmodSync(wrapperPath, 0o755);
  process.env.PASEO_TEST_GIT_FAILURE = mode;
  process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
  return binDir;
}

function readBranch(repoDir: string): string {
  return execFileSync(realGitPath, ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoDir })
    .toString()
    .trim();
}

function readStatus(repoDir: string): string {
  return execFileSync(realGitPath, ["status", "--porcelain"], { cwd: repoDir }).toString().trim();
}

function hasMergeHead(repoDir: string): boolean {
  try {
    execFileSync(realGitPath, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: repoDir });
    return true;
  } catch {
    return false;
  }
}

async function captureFailure(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
    return null;
  } catch (error) {
    return error;
  }
}

async function withMergeRepository(
  options: { conflicting: boolean; failureMode: GitFailureMode },
  run: (repoDir: string) => Promise<void>,
): Promise<void> {
  const previousConcurrency = process.env.PASEO_GIT_CONCURRENCY;
  const previousFailureMode = process.env.PASEO_TEST_GIT_FAILURE;
  const previousPath = process.env.PATH;
  const repoDir = createMergeRepository(options.conflicting);
  let wrapperDir: string | null = null;
  try {
    process.env.PASEO_GIT_CONCURRENCY = "1";
    wrapperDir = installGitFailureWrapper(options.failureMode);
    vi.resetModules();
    await run(repoDir);
  } finally {
    if (previousConcurrency === undefined) delete process.env.PASEO_GIT_CONCURRENCY;
    else process.env.PASEO_GIT_CONCURRENCY = previousConcurrency;
    if (previousFailureMode === undefined) delete process.env.PASEO_TEST_GIT_FAILURE;
    else process.env.PASEO_TEST_GIT_FAILURE = previousFailureMode;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (wrapperDir) rmSync(wrapperDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
    vi.resetModules();
  }
}

const TEST_TIMEOUT = 30_000;

describe("checkout merge cleanup", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it(
    "preserves MergeConflictError when merge cleanup succeeds",
    async () => {
      await withMergeRepository({ conflicting: true, failureMode: "none" }, async (repoDir) => {
        const { mergeToBase, MergeConflictError } = await import("./checkout-git.js");

        const failure = await captureFailure(mergeToBase(repoDir, { baseRef: "main" }));

        expect(failure).toBeInstanceOf(MergeConflictError);
        if (!(failure instanceof MergeConflictError)) throw failure;
        expect(failure.conflictFiles).toContain("conflict.txt");
        expect(readBranch(repoDir)).toBe("feature");
        expect(readStatus(repoDir)).toBe("");
        expect(hasMergeHead(repoDir)).toBe(false);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "preserves MergeFromBaseConflictError when merge cleanup succeeds",
    async () => {
      await withMergeRepository({ conflicting: true, failureMode: "none" }, async (repoDir) => {
        const { mergeFromBase, MergeFromBaseConflictError } = await import("./checkout-git.js");

        const failure = await captureFailure(mergeFromBase(repoDir, { baseRef: "main" }));

        expect(failure).toBeInstanceOf(MergeFromBaseConflictError);
        if (!(failure instanceof MergeFromBaseConflictError)) throw failure;
        expect(failure.conflictFiles).toContain("conflict.txt");
        expect(readBranch(repoDir)).toBe("feature");
        expect(readStatus(repoDir)).toBe("");
        expect(hasMergeHead(repoDir)).toBe(false);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "surfaces an aggregated cleanup failure when abort fails",
    async () => {
      await withMergeRepository({ conflicting: true, failureMode: "abort" }, async (repoDir) => {
        const { mergeToBase, MergeCleanupError, MergeConflictError } =
          await import("./checkout-git.js");
        const { toCheckoutError } = await import("../server/checkout-git-utils.js");

        const failure = await captureFailure(mergeToBase(repoDir, { baseRef: "main" }));

        expect(failure).toBeInstanceOf(MergeCleanupError);
        expect(failure).not.toBeInstanceOf(MergeConflictError);
        if (!(failure instanceof MergeCleanupError)) throw failure;
        expect(failure.cleanupErrors).toEqual([
          expect.objectContaining({ message: expect.stringContaining("abort blocked") }),
          expect.objectContaining({ message: expect.stringContaining("MERGE_HEAD still exists") }),
          expect.objectContaining({ message: expect.stringContaining("unmerged index entries") }),
          expect.objectContaining({ message: expect.stringContaining("checkout feature") }),
        ]);
        expect(toCheckoutError(failure)).toEqual({
          code: "UNKNOWN",
          message: expect.stringContaining("checkout may require manual recovery"),
        });
        expect(readBranch(repoDir)).toBe("main");
        expect(readStatus(repoDir)).toContain("UU conflict.txt");
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "types cleanup failure after a generic merge failure",
    async () => {
      await withMergeRepository(
        { conflicting: false, failureMode: "generic-cleanup" },
        async (repoDir) => {
          const { mergeToBase, MergeCleanupError, MergeConflictError } =
            await import("./checkout-git.js");
          const { toCheckoutError } = await import("../server/checkout-git-utils.js");

          const failure = await captureFailure(mergeToBase(repoDir, { baseRef: "main" }));

          expect(failure).toBeInstanceOf(MergeCleanupError);
          expect(failure).not.toBeInstanceOf(MergeConflictError);
          if (!(failure instanceof MergeCleanupError)) throw failure;
          expect(failure.conflictFiles).toEqual([]);
          expect(failure.operationErrors).toEqual([
            expect.objectContaining({ message: expect.stringContaining("generic merge blocked") }),
          ]);
          expect(failure.diagnosticErrors).toEqual([]);
          expect(failure.cleanupErrors).toEqual([
            expect.objectContaining({
              message: expect.stringContaining("generic cleanup blocked"),
            }),
          ]);
          expect(failure.errors).toEqual([
            ...failure.operationErrors,
            ...failure.diagnosticErrors,
            ...failure.cleanupErrors,
          ]);
          expect(failure.cause).toBe(failure.operationErrors[0]);
          expect(toCheckoutError(failure)).toEqual({
            code: "UNKNOWN",
            message: expect.stringContaining("checkout may require manual recovery"),
          });
          expect(readBranch(repoDir)).toBe("feature");
          expect(readStatus(repoDir)).toBe("");
        },
      );
    },
    TEST_TIMEOUT,
  );

  it(
    "surfaces merge-from-base abort failure instead of a recoverable conflict",
    async () => {
      await withMergeRepository({ conflicting: true, failureMode: "abort" }, async (repoDir) => {
        const { mergeFromBase, MergeCleanupError, MergeFromBaseConflictError } =
          await import("./checkout-git.js");

        const failure = await captureFailure(mergeFromBase(repoDir, { baseRef: "main" }));

        expect(failure).toBeInstanceOf(MergeCleanupError);
        expect(failure).not.toBeInstanceOf(MergeFromBaseConflictError);
        if (!(failure instanceof MergeCleanupError)) throw failure;
        expect(failure.cleanupErrors).toEqual([
          expect.objectContaining({ message: expect.stringContaining("abort blocked") }),
          expect.objectContaining({ message: expect.stringContaining("MERGE_HEAD still exists") }),
          expect.objectContaining({ message: expect.stringContaining("unmerged index entries") }),
        ]);
        expect(readBranch(repoDir)).toBe("feature");
        expect(readStatus(repoDir)).toContain("UU conflict.txt");
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "cleans a squash conflict without relying on MERGE_HEAD",
    async () => {
      await withMergeRepository({ conflicting: true, failureMode: "none" }, async (repoDir) => {
        const { mergeToBase, MergeConflictError } = await import("./checkout-git.js");

        const failure = await captureFailure(
          mergeToBase(repoDir, { baseRef: "main", mode: "squash" }),
        );

        expect(failure).toBeInstanceOf(MergeConflictError);
        expect(readBranch(repoDir)).toBe("feature");
        expect(readStatus(repoDir)).toBe("");
        expect(hasMergeHead(repoDir)).toBe(false);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "does not discard staged work when squash cleanup would require a reset",
    async () => {
      await withMergeRepository({ conflicting: true, failureMode: "none" }, async (repoDir) => {
        writeFileSync(join(repoDir, "staged.txt"), "staged\n");
        execFileSync(realGitPath, ["add", "staged.txt"], { cwd: repoDir });
        const { mergeToBase } = await import("./checkout-git.js");

        await expect(mergeToBase(repoDir, { baseRef: "main", mode: "squash" })).rejects.toThrow(
          "Working directory has uncommitted changes.",
        );
        expect(readBranch(repoDir)).toBe("feature");
        expect(readStatus(repoDir)).toBe("A  staged.txt");
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "rejects a successful abort that leaves merge state behind",
    async () => {
      await withMergeRepository(
        { conflicting: true, failureMode: "abort-noop" },
        async (repoDir) => {
          const { mergeToBase, MergeCleanupError, MergeConflictError } =
            await import("./checkout-git.js");

          const failure = await captureFailure(mergeToBase(repoDir, { baseRef: "main" }));

          expect(failure).toBeInstanceOf(MergeCleanupError);
          expect(failure).not.toBeInstanceOf(MergeConflictError);
          if (!(failure instanceof MergeCleanupError)) throw failure;
          expect(failure.cleanupErrors).toEqual([
            expect.objectContaining({
              message: expect.stringContaining("MERGE_HEAD still exists"),
            }),
            expect.objectContaining({
              message: expect.stringContaining("unmerged index entries"),
            }),
            expect.objectContaining({ message: expect.stringContaining("checkout feature") }),
          ]);
          expect(readBranch(repoDir)).toBe("main");
          expect(readStatus(repoDir)).toContain("UU conflict.txt");
        },
      );
    },
    TEST_TIMEOUT,
  );

  it(
    "surfaces branch restoration failure after a successful merge",
    async () => {
      await withMergeRepository({ conflicting: false, failureMode: "restore" }, async (repoDir) => {
        const { mergeToBase, MergeCleanupError } = await import("./checkout-git.js");

        const failure = await captureFailure(mergeToBase(repoDir, { baseRef: "main" }));

        expect(failure).toBeInstanceOf(MergeCleanupError);
        if (!(failure instanceof MergeCleanupError)) throw failure;
        expect(failure.cleanupErrors).toEqual([
          expect.objectContaining({ message: expect.stringContaining("restore blocked") }),
        ]);
        expect(readBranch(repoDir)).toBe("main");
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "types restoration failure after a generic merge operation failure",
    async () => {
      await withMergeRepository(
        { conflicting: false, failureMode: "generic-restore" },
        async (repoDir) => {
          const { mergeToBase, MergeCleanupError, MergeConflictError } =
            await import("./checkout-git.js");
          const { toCheckoutError } = await import("../server/checkout-git-utils.js");

          const failure = await captureFailure(mergeToBase(repoDir, { baseRef: "main" }));

          expect(failure).toBeInstanceOf(MergeCleanupError);
          expect(failure).not.toBeInstanceOf(MergeConflictError);
          if (!(failure instanceof MergeCleanupError)) throw failure;
          expect(failure.conflictFiles).toEqual([]);
          expect(failure.operationErrors).toEqual([
            expect.objectContaining({
              message: expect.stringContaining("generic checkout blocked"),
            }),
          ]);
          expect(failure.diagnosticErrors).toEqual([]);
          expect(failure.cleanupErrors).toEqual([
            expect.objectContaining({
              message: expect.stringContaining("generic restore blocked"),
            }),
          ]);
          expect(failure.errors).toEqual([
            ...failure.operationErrors,
            ...failure.diagnosticErrors,
            ...failure.cleanupErrors,
          ]);
          expect(failure.cause).toBe(failure.operationErrors[0]);
          expect(toCheckoutError(failure)).toEqual({
            code: "UNKNOWN",
            message: expect.stringContaining("checkout may require manual recovery"),
          });
          expect(readBranch(repoDir)).toBe("feature");
          expect(readStatus(repoDir)).toBe("");
        },
      );
    },
    TEST_TIMEOUT,
  );

  it(
    "surfaces branch restoration failure instead of a recoverable conflict",
    async () => {
      await withMergeRepository({ conflicting: true, failureMode: "restore" }, async (repoDir) => {
        const { mergeToBase, MergeCleanupError, MergeConflictError } =
          await import("./checkout-git.js");

        const failure = await captureFailure(mergeToBase(repoDir, { baseRef: "main" }));

        expect(failure).toBeInstanceOf(MergeCleanupError);
        expect(failure).not.toBeInstanceOf(MergeConflictError);
        if (!(failure instanceof MergeCleanupError)) throw failure;
        expect(failure.cleanupErrors).toEqual([
          expect.objectContaining({ message: expect.stringContaining("restore blocked") }),
        ]);
        expect(readBranch(repoDir)).toBe("main");
        expect(readStatus(repoDir)).toBe("");
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "rejects a restoration that silently leaves the wrong branch checked out",
    async () => {
      await withMergeRepository(
        { conflicting: false, failureMode: "restore-noop" },
        async (repoDir) => {
          const { mergeToBase, MergeCleanupError } = await import("./checkout-git.js");

          const failure = await captureFailure(mergeToBase(repoDir, { baseRef: "main" }));

          expect(failure).toBeInstanceOf(MergeCleanupError);
          if (!(failure instanceof MergeCleanupError)) throw failure;
          expect(failure.cleanupErrors).toEqual([
            expect.objectContaining({
              message: expect.stringContaining("expected feature, found main"),
            }),
          ]);
          expect(readBranch(repoDir)).toBe("main");
        },
      );
    },
    TEST_TIMEOUT,
  );
});
