import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCheckoutDiff } from "./checkout-git.js";

// Every test builds real git superproject+submodule fixtures (init + clone),
// which spikes well past the 5s default under parallel CI load. Give them room.
vi.setConfig({ testTimeout: 30_000 });

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function configureRepo(cwd: string): void {
  git(cwd, ["config", "user.email", "test@test.com"]);
  git(cwd, ["config", "user.name", "Test"]);
}

function commitAll(cwd: string, message: string): void {
  git(cwd, ["add", "-A"]);
  git(cwd, ["-c", "commit.gpgsign=false", "commit", "-m", message]);
}

interface SubmoduleFixture {
  tempDir: string;
  sourceDir: string;
  repoDir: string;
  submoduleDir: string;
  initialSubmoduleSha: string;
}

function createSubmoduleFixture(): SubmoduleFixture {
  const tempDir = realpathSync.native(mkdtempSync(join(tmpdir(), "checkout-submodule-test-")));
  const sourceDir = join(tempDir, "source");
  mkdirSync(sourceDir);
  git(sourceDir, ["init", "-b", "main"]);
  configureRepo(sourceDir);
  writeFileSync(join(sourceDir, "service.ts"), "export const value = 1;\n");
  commitAll(sourceDir, "initial submodule content");
  const initialSubmoduleSha = git(sourceDir, ["rev-parse", "HEAD"]);

  const repoDir = join(tempDir, "repo");
  mkdirSync(repoDir);
  git(repoDir, ["init", "-b", "main"]);
  configureRepo(repoDir);
  writeFileSync(join(repoDir, "README.md"), "root\n");
  commitAll(repoDir, "initial root content");
  git(repoDir, [
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    sourceDir,
    "modules/service",
  ]);
  commitAll(repoDir, "add service submodule");

  return {
    tempDir,
    sourceDir,
    repoDir,
    submoduleDir: join(repoDir, "modules/service"),
    initialSubmoduleSha,
  };
}

function denseSubmoduleContent(): string {
  // Mirror the daemon-e2e oversized fixture: keep each line under the 10k-char highlight
  // cap (MAX_DIFF_HIGHLIGHT_LINE_CHARS) so highlighting is applied, and each file's raw
  // diff under the 1MB per-file / 2MB total text gates so it reaches the structured
  // accumulator instead of becoming a placeholder. Two such files then expand past
  // CHECKOUT_DIFF_MAX_STRUCTURED_BYTES (~23MB) once highlighted.
  const denseLine = `const v = ${"a+".repeat(2_000)}a;`;
  return `${Array.from({ length: 235 }, () => denseLine).join("\n")}\n`;
}

function seedDenseSubmoduleOverflow(submoduleDir: string): void {
  writeFileSync(join(submoduleDir, "large-a.js"), "const value = 0;\n");
  writeFileSync(join(submoduleDir, "large-b.js"), "const value = 0;\n");
  commitAll(submoduleDir, "seed dense submodule files");
  writeFileSync(join(submoduleDir, "large-a.js"), denseSubmoduleContent());
  writeFileSync(join(submoduleDir, "large-b.js"), denseSubmoduleContent());
}

describe("checkout submodule diffs", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("expands tracked, renamed, and untracked submodule files with canonical paths", async () => {
    const fixture = createSubmoduleFixture();
    tempDirs.push(fixture.tempDir);
    git(fixture.submoduleDir, ["mv", "service.ts", "renamed service.ts"]);
    writeFileSync(join(fixture.submoduleDir, "new file.ts"), "export const added = true;\n");
    const nestedCwd = join(fixture.repoDir, "tools/nested");
    mkdirSync(nestedCwd, { recursive: true });

    const result = await getCheckoutDiff(nestedCwd, {
      mode: "uncommitted",
      includeStructured: true,
    });

    expect(result.diff).toContain("Subproject commit");
    expect(
      result.structured?.map(({ path, oldPath, submodulePath }) => ({
        path,
        oldPath,
        submodulePath,
      })),
    ).toEqual([
      {
        path: "modules/service/renamed service.ts",
        oldPath: "modules/service/service.ts",
        submodulePath: "modules/service",
      },
      {
        path: "modules/service/new file.ts",
        oldPath: undefined,
        submodulePath: "modules/service",
      },
    ]);
    expect(result.submodules).toEqual([
      {
        path: "modules/service",
        branch: "main",
        currentSha: fixture.initialSubmoduleSha,
        headPinnedSha: fixture.initialSubmoduleSha,
        checkoutState: "checked_out",
        changeState: "worktree_modified",
      },
    ]);
  });

  it("detects an untracked-only submodule change", async () => {
    const fixture = createSubmoduleFixture();
    tempDirs.push(fixture.tempDir);
    writeFileSync(join(fixture.submoduleDir, "untracked-only.ts"), "export const added = true;\n");

    const result = await getCheckoutDiff(fixture.repoDir, {
      mode: "uncommitted",
      includeStructured: true,
    });

    expect(
      result.structured?.map((file) => ({
        path: file.path,
        isNew: file.isNew,
        submodulePath: file.submodulePath,
      })),
    ).toEqual([
      {
        path: "modules/service/untracked-only.ts",
        isNew: true,
        submodulePath: "modules/service",
      },
    ]);
    expect(result.submodules?.map(({ path, changeState }) => ({ path, changeState }))).toEqual([
      { path: "modules/service", changeState: "worktree_modified" },
    ]);
  });

  it("uses the superproject's exact pinned commits for a base diff", async () => {
    const fixture = createSubmoduleFixture();
    tempDirs.push(fixture.tempDir);
    git(fixture.repoDir, ["checkout", "-b", "feature"]);
    writeFileSync(join(fixture.submoduleDir, "service.ts"), "export const value = 2;\n");
    writeFileSync(join(fixture.submoduleDir, "recorded.ts"), "export const recorded = true;\n");
    commitAll(fixture.submoduleDir, "recorded submodule change");
    const recordedSha = git(fixture.submoduleDir, ["rev-parse", "HEAD"]);
    commitAll(fixture.repoDir, "record submodule pointer");

    writeFileSync(join(fixture.submoduleDir, "current-only.ts"), "not in recorded pointer\n");
    commitAll(fixture.submoduleDir, "move current checkout beyond recorded pointer");
    const currentSha = git(fixture.submoduleDir, ["rev-parse", "HEAD"]);

    const result = await getCheckoutDiff(fixture.repoDir, {
      mode: "base",
      baseRef: "main",
      includeStructured: true,
    });

    expect(result.structured?.map((file) => file.path)).toEqual([
      "modules/service/recorded.ts",
      "modules/service/service.ts",
    ]);
    expect(result.submodules).toEqual([
      {
        path: "modules/service",
        branch: "main",
        currentSha,
        basePinnedSha: fixture.initialSubmoduleSha,
        headPinnedSha: recordedSha,
        checkoutState: "checked_out",
        changeState: "recorded_change",
      },
    ]);
  });

  it("reports detached and clean-head-differs states explicitly", async () => {
    const fixture = createSubmoduleFixture();
    tempDirs.push(fixture.tempDir);
    writeFileSync(join(fixture.submoduleDir, "local.ts"), "local commit\n");
    commitAll(fixture.submoduleDir, "local submodule commit");
    const currentSha = git(fixture.submoduleDir, ["rev-parse", "HEAD"]);
    git(fixture.submoduleDir, ["checkout", "--detach", currentSha]);

    const result = await getCheckoutDiff(fixture.repoDir, {
      mode: "uncommitted",
      includeStructured: true,
    });

    expect(result.structured).toEqual([]);
    expect(result.submodules).toEqual([
      {
        path: "modules/service",
        branch: null,
        currentSha,
        headPinnedSha: fixture.initialSubmoduleSha,
        checkoutState: "checked_out",
        changeState: "head_differs",
      },
    ]);
  });

  it("keeps an uninitialized changed submodule visible when history cannot be read", async () => {
    const fixture = createSubmoduleFixture();
    tempDirs.push(fixture.tempDir);
    git(fixture.repoDir, ["checkout", "-b", "feature"]);
    writeFileSync(join(fixture.submoduleDir, "service.ts"), "export const value = 2;\n");
    commitAll(fixture.submoduleDir, "new submodule commit");
    const recordedSha = git(fixture.submoduleDir, ["rev-parse", "HEAD"]);
    commitAll(fixture.repoDir, "record submodule pointer");
    git(fixture.repoDir, ["submodule", "deinit", "-f", "modules/service"]);

    const result = await getCheckoutDiff(fixture.repoDir, {
      mode: "base",
      baseRef: "main",
      includeStructured: true,
    });

    expect(result.structured).toEqual([]);
    expect(result.submodules).toEqual([
      {
        path: "modules/service",
        branch: null,
        currentSha: null,
        basePinnedSha: fixture.initialSubmoduleSha,
        headPinnedSha: recordedSha,
        checkoutState: "uninitialized",
        changeState: "history_unavailable",
      },
    ]);
  });

  it("reports missing pinned history without failing the outer diff", async () => {
    const fixture = createSubmoduleFixture();
    tempDirs.push(fixture.tempDir);
    const missingSha = "1111111111111111111111111111111111111111";
    git(fixture.repoDir, ["checkout", "-b", "feature"]);
    git(fixture.repoDir, ["update-index", "--cacheinfo", `160000,${missingSha},modules/service`]);
    git(fixture.repoDir, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "record unavailable submodule commit",
    ]);

    const result = await getCheckoutDiff(fixture.repoDir, {
      mode: "base",
      baseRef: "main",
      includeStructured: true,
    });

    expect(result.diff).toContain(missingSha);
    expect(result.structured).toEqual([]);
    expect(result.submodules).toEqual([
      {
        path: "modules/service",
        branch: "main",
        currentSha: fixture.initialSubmoduleSha,
        basePinnedSha: fixture.initialSubmoduleSha,
        headPinnedSha: missingSha,
        checkoutState: "checked_out",
        changeState: "history_unavailable",
      },
    ]);
  });

  it("keeps identical relative filenames unique across two submodules", async () => {
    const fixture = createSubmoduleFixture();
    tempDirs.push(fixture.tempDir);
    git(fixture.repoDir, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      fixture.sourceDir,
      "modules/other",
    ]);
    commitAll(fixture.repoDir, "add second submodule");
    writeFileSync(join(fixture.submoduleDir, "service.ts"), "export const value = 2;\n");
    writeFileSync(join(fixture.repoDir, "modules/other/service.ts"), "export const value = 3;\n");

    const result = await getCheckoutDiff(fixture.repoDir, {
      mode: "uncommitted",
      includeStructured: true,
    });

    expect(result.structured?.map((file) => [file.path, file.submodulePath])).toEqual([
      ["modules/other/service.ts", "modules/other"],
      ["modules/service/service.ts", "modules/service"],
    ]);
    expect(result.submodules?.map((submodule) => submodule.path)).toEqual([
      "modules/other",
      "modules/service",
    ]);
  });

  it("reports added and deleted gitlinks without emitting pointer rows", async () => {
    const fixture = createSubmoduleFixture();
    tempDirs.push(fixture.tempDir);
    git(fixture.repoDir, ["checkout", "-b", "feature"]);
    git(fixture.repoDir, ["rm", "-f", "modules/service"]);
    git(fixture.repoDir, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      fixture.sourceDir,
      "modules/replacement",
    ]);
    commitAll(fixture.repoDir, "replace submodule");

    const result = await getCheckoutDiff(fixture.repoDir, {
      mode: "base",
      baseRef: "main",
      includeStructured: true,
    });

    expect(result.structured?.some((file) => file.path === "modules/service")).toBe(false);
    expect(result.structured?.map((file) => [file.path, file.submodulePath])).toContainEqual([
      "modules/replacement/service.ts",
      "modules/replacement",
    ]);
    expect(result.submodules).toEqual([
      {
        path: "modules/replacement",
        branch: "main",
        currentSha: fixture.initialSubmoduleSha,
        basePinnedSha: null,
        headPinnedSha: fixture.initialSubmoduleSha,
        checkoutState: "checked_out",
        changeState: "added",
      },
      {
        path: "modules/service",
        branch: null,
        currentSha: null,
        basePinnedSha: fixture.initialSubmoduleSha,
        headPinnedSha: null,
        checkoutState: "unavailable",
        changeState: "deleted",
      },
    ]);
  });

  it("preserves a regular-file deletion when the path becomes a gitlink", async () => {
    const fixture = createSubmoduleFixture();
    tempDirs.push(fixture.tempDir);
    writeFileSync(join(fixture.repoDir, "replacement"), "ordinary file\n");
    writeFileSync(join(fixture.repoDir, "normal.txt"), "before\n");
    commitAll(fixture.repoDir, "add ordinary replacement path");
    git(fixture.repoDir, ["checkout", "-b", "feature"]);
    writeFileSync(join(fixture.repoDir, "normal.txt"), "after\n");
    git(fixture.repoDir, ["rm", "replacement"]);
    git(fixture.repoDir, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      fixture.sourceDir,
      "replacement",
    ]);
    commitAll(fixture.repoDir, "replace file with gitlink");

    const result = await getCheckoutDiff(fixture.repoDir, {
      mode: "base",
      baseRef: "main",
      includeStructured: true,
    });

    expect(
      result.structured
        ?.filter((file) => file.path === "replacement" && file.submodulePath === undefined)
        .map((file) => ({
          path: file.path,
          isNew: file.isNew,
          isDeleted: file.isDeleted,
          submodulePath: file.submodulePath,
        })),
    ).toEqual([
      {
        path: "replacement",
        isNew: false,
        isDeleted: true,
        submodulePath: undefined,
      },
    ]);
    expect(
      result.structured
        ?.filter((file) => file.path === "normal.txt" && file.submodulePath === undefined)
        .map((file) => ({
          path: file.path,
          isNew: file.isNew,
          isDeleted: file.isDeleted,
        })),
    ).toEqual([{ path: "normal.txt", isNew: false, isDeleted: false }]);
    expect(result.structured?.map((file) => [file.path, file.submodulePath])).toContainEqual([
      "replacement/service.ts",
      "replacement",
    ]);
    expect(result.submodules).toEqual([
      {
        path: "replacement",
        branch: "main",
        currentSha: fixture.initialSubmoduleSha,
        basePinnedSha: null,
        headPinnedSha: fixture.initialSubmoduleSha,
        checkoutState: "checked_out",
        changeState: "added",
      },
    ]);
  });

  it("preserves a regular-file addition when a gitlink becomes a file", async () => {
    const fixture = createSubmoduleFixture();
    tempDirs.push(fixture.tempDir);
    git(fixture.repoDir, ["checkout", "-b", "feature"]);
    git(fixture.repoDir, ["rm", "-f", "modules/service"]);
    writeFileSync(join(fixture.repoDir, "modules/service"), "ordinary replacement\n");
    commitAll(fixture.repoDir, "replace gitlink with file");

    const result = await getCheckoutDiff(fixture.repoDir, {
      mode: "base",
      baseRef: "main",
      includeStructured: true,
    });

    expect(
      result.structured
        ?.filter((file) => file.path === "modules/service" && file.submodulePath === undefined)
        .map((file) => ({
          path: file.path,
          isNew: file.isNew,
          isDeleted: file.isDeleted,
          submodulePath: file.submodulePath,
        })),
    ).toEqual([
      {
        path: "modules/service",
        isNew: true,
        isDeleted: false,
        submodulePath: undefined,
      },
    ]);
    expect(result.submodules).toEqual([
      {
        path: "modules/service",
        branch: null,
        currentSha: null,
        basePinnedSha: fixture.initialSubmoduleSha,
        headPinnedSha: null,
        checkoutState: "unavailable",
        changeState: "deleted",
      },
    ]);
  });

  it("keeps added state for a clean uncommitted submodule checkout", async () => {
    const fixture = createSubmoduleFixture();
    tempDirs.push(fixture.tempDir);
    git(fixture.repoDir, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      fixture.sourceDir,
      "modules/new",
    ]);

    const result = await getCheckoutDiff(fixture.repoDir, {
      mode: "uncommitted",
      includeStructured: true,
    });

    expect(result.structured?.map((file) => [file.path, file.submodulePath])).toEqual([
      [".gitmodules", undefined],
    ]);
    expect(result.submodules).toEqual([
      {
        path: "modules/new",
        branch: "main",
        currentSha: fixture.initialSubmoduleSha,
        headPinnedSha: null,
        checkoutState: "checked_out",
        changeState: "added",
      },
    ]);
  });

  it("keeps superproject files when a submodule's inner diff overflows the structured cap", async () => {
    const fixture = createSubmoduleFixture();
    tempDirs.push(fixture.tempDir);

    // Ordinary superproject changes that must survive the submodule overflow.
    writeFileSync(join(fixture.repoDir, "README.md"), "root changed\n");
    writeFileSync(join(fixture.repoDir, "ordinary-new.ts"), "export const ordinary = 1;\n");
    writeFileSync(join(fixture.repoDir, "ordinary-second.ts"), "export const second = 2;\n");

    seedDenseSubmoduleOverflow(fixture.submoduleDir);
    const currentSha = git(fixture.submoduleDir, ["rev-parse", "HEAD"]);

    const result = await getCheckoutDiff(fixture.repoDir, {
      mode: "uncommitted",
      includeStructured: true,
    });

    // Superproject diff must not blank out for a submodule overflow.
    expect(result.diffTooLarge).toBeUndefined();

    const structuredPaths = result.structured?.map((file) => file.path) ?? [];
    expect(structuredPaths).toContain("README.md");
    expect(structuredPaths).toContain("ordinary-new.ts");
    expect(structuredPaths).toContain("ordinary-second.ts");
    // The overflowing submodule contributes no child rows.
    expect(result.structured?.some((file) => file.submodulePath === "modules/service")).toBe(false);

    // The plain diff string is preserved and carries the ordinary files plus the placeholder.
    expect(result.diff).toContain("README.md");
    expect(result.diff).toContain("ordinary-new.ts");
    expect(result.diff).toContain("# modules/service: diff too large omitted");

    // The submodule keeps its header metadata even though its rows were dropped.
    expect(result.submodules).toEqual([
      {
        path: "modules/service",
        branch: "main",
        currentSha,
        headPinnedSha: fixture.initialSubmoduleSha,
        checkoutState: "checked_out",
        changeState: "worktree_modified",
      },
    ]);
  }, 120000);

  it("degrades only the overflowing submodule and keeps the one that fits", async () => {
    const fixture = createSubmoduleFixture();
    tempDirs.push(fixture.tempDir);
    git(fixture.repoDir, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      fixture.sourceDir,
      "modules/other",
    ]);
    commitAll(fixture.repoDir, "add second submodule");
    const otherDir = join(fixture.repoDir, "modules/other");

    // Ordinary superproject change.
    writeFileSync(join(fixture.repoDir, "README.md"), "root changed\n");

    // modules/other sorts before modules/service, so it is processed first and fits.
    writeFileSync(join(otherDir, "service.ts"), "export const value = 99;\n");

    // modules/service overflows the shared structured cap.
    seedDenseSubmoduleOverflow(fixture.submoduleDir);

    const result = await getCheckoutDiff(fixture.repoDir, {
      mode: "uncommitted",
      includeStructured: true,
    });

    expect(result.diffTooLarge).toBeUndefined();

    const structuredPaths = result.structured?.map((file) => file.path) ?? [];
    expect(structuredPaths).toContain("README.md");
    // The fitting submodule keeps its child rows.
    expect(structuredPaths).toContain("modules/other/service.ts");
    // The overflowing submodule contributes none.
    expect(result.structured?.some((file) => file.submodulePath === "modules/service")).toBe(false);

    expect(result.diff).toContain("# modules/service: diff too large omitted");
    expect(result.diff).not.toContain("# modules/other: diff too large omitted");

    expect(result.submodules?.map(({ path, changeState }) => ({ path, changeState }))).toEqual([
      { path: "modules/other", changeState: "worktree_modified" },
      { path: "modules/service", changeState: "worktree_modified" },
    ]);
  }, 120000);
});
