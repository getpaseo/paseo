import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Goal } from "@getpaseo/protocol/goal/types";
import { createGitPort } from "./git-ops.js";
import { integrationProblem, shellQuote } from "./goal-recovery.js";

const port = createGitPort();

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("git ops against real repositories", () => {
  let root: string;
  let repo: string;
  let integration: string;
  let work: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paseo-git-ops-"));
    repo = join(root, "repo");
    execFileSync("git", ["init", "-b", "main", repo], { stdio: "pipe" });
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    await writeFile(join(repo, "shared.txt"), "base\n");
    git(repo, "add", "-A");
    git(repo, "-c", "commit.gpgsign=false", "commit", "-m", "initial");
    integration = join(root, "integration");
    work = join(root, "work");
    git(repo, "worktree", "add", "-b", "goal/integration", integration);
    git(repo, "worktree", "add", "-b", "task/work", work);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("capture commits uncommitted work and reports explicit commits and files", async () => {
    await writeFile(join(work, "feature.txt"), "new\n");
    await writeFile(join(work, "shared.txt"), "changed\n");

    const captured = await port.capture({
      cwd: work,
      integrationCommit: "goal/integration",
      message: "task a",
    });

    expect(captured).not.toBeNull();
    expect(captured?.branch).toBe("task/work");
    expect(captured?.baseCommit).toBe(git(repo, "rev-parse", "main"));
    expect(captured?.headCommit).toBe(git(work, "rev-parse", "HEAD"));
    expect(captured?.files.map((f) => [f.status, f.path]).sort()).toEqual([
      ["A", "feature.txt"],
      ["M", "shared.txt"],
    ]);
    expect(git(work, "status", "--porcelain")).toBe("");
    expect(git(work, "log", "-1", "--format=%an")).toBe("Paseo Goal Manager");
  });

  test("workSummary shows committed and uncommitted work and counts untracked files", async () => {
    const base = git(work, "rev-parse", "HEAD");
    await writeFile(join(work, "feature.txt"), "new\n");
    git(work, "add", "feature.txt");
    git(work, "-c", "commit.gpgsign=false", "commit", "-m", "feature");
    await writeFile(join(work, "shared.txt"), "changed\n");
    await writeFile(join(work, "notes.txt"), "scratch\n");

    const summary = await port.workSummary({ cwd: work, baseCommit: base });
    expect(summary).toContain(`Changes since ${base}:`);
    expect(summary).toContain("feature.txt");
    expect(summary).toMatch(/M shared\.txt/);
    expect(summary).toContain("Untracked files: 1");
    // Only tracked files are listed; the untracked one is counted, not named.
    expect(summary).not.toContain("notes.txt");
  });

  test("workSummary is cut to 4000 characters", async () => {
    const base = git(work, "rev-parse", "HEAD");
    for (let i = 0; i < 200; i += 1) {
      await writeFile(join(work, `a-rather-long-file-name-to-fill-the-summary-${i}.txt`), "x\n");
    }
    git(work, "add", "-A");
    git(work, "-c", "commit.gpgsign=false", "commit", "-m", "many");
    const summary = await port.workSummary({ cwd: work, baseCommit: base });
    expect(summary.length).toBeLessThanOrEqual(4000);
    expect(summary.endsWith("[truncated]")).toBe(true);
  });

  test("workSummary of a directory git cannot read says it is unavailable", async () => {
    const summary = await port.workSummary({ cwd: join(root, "missing") });
    expect(summary).toMatch(/^\(work summary unavailable: /);
  });

  test("capture keeps the agent's own commits and returns null when nothing changed", async () => {
    expect(
      await port.capture({ cwd: work, integrationCommit: "goal/integration", message: "x" }),
    ).toBeNull();

    await writeFile(join(work, "a.txt"), "a\n");
    git(work, "add", "-A");
    git(work, "-c", "commit.gpgsign=false", "commit", "-m", "agent commit");
    const agentHead = git(work, "rev-parse", "HEAD");
    const captured = await port.capture({
      cwd: work,
      integrationCommit: "goal/integration",
      message: "x",
    });
    expect(captured?.headCommit).toBe(agentHead);
  });

  test("merge brings a change into the integration branch with a merge commit", async () => {
    await writeFile(join(work, "feature.txt"), "new\n");
    const captured = await port.capture({
      cwd: work,
      integrationCommit: "goal/integration",
      message: "task a",
    });

    const result = await port.merge({
      cwd: integration,
      commit: captured?.headCommit ?? "",
      message: "Integrate task a",
    });

    expect(result.ok).toBe(true);
    expect(await readFile(join(integration, "feature.txt"), "utf8")).toBe("new\n");
    expect(git(integration, "log", "-1", "--format=%s")).toBe("Integrate task a");
    expect(git(integration, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3);
  });

  test("a conflicting merge is aborted, reported, and leaves the branch untouched", async () => {
    // Integration changes shared.txt one way...
    await writeFile(join(integration, "shared.txt"), "integration side\n");
    git(integration, "add", "-A");
    git(integration, "-c", "commit.gpgsign=false", "commit", "-m", "integration edit");
    const before = git(integration, "rev-parse", "HEAD");
    // ...and the task changed it another way.
    await writeFile(join(work, "shared.txt"), "task side\n");
    const captured = await port.capture({
      cwd: work,
      integrationCommit: "goal/integration",
      message: "task",
    });

    const result = await port.merge({
      cwd: integration,
      commit: captured?.headCommit ?? "",
      message: "Integrate",
    });

    expect(result).toEqual({ ok: false, conflicts: ["shared.txt"] });
    expect(git(integration, "rev-parse", "HEAD")).toBe(before);
    expect(git(integration, "status", "--porcelain")).toBe("");
    expect(await readFile(join(integration, "shared.txt"), "utf8")).toBe("integration side\n");
  });

  test("merge refuses to run when a tracked file in the integration worktree is modified", async () => {
    await writeFile(join(integration, "shared.txt"), "edited in place\n");
    await expect(
      port.merge({ cwd: integration, commit: git(repo, "rev-parse", "main"), message: "m" }),
    ).rejects.toThrow("Integration worktree has uncommitted changes:\nM shared.txt");
  });

  test("an unrelated untracked file does not block a merge and is left alone", async () => {
    await mkdir(join(integration, ".gjc"));
    await writeFile(join(integration, ".gjc", "state.json"), "{}\n");
    await writeFile(join(work, "feature.txt"), "new\n");
    const captured = await port.capture({
      cwd: work,
      integrationCommit: "goal/integration",
      message: "task",
    });

    const result = await port.merge({
      cwd: integration,
      commit: captured?.headCommit ?? "",
      message: "Integrate",
    });

    expect(result).toEqual({ ok: true, headCommit: git(integration, "rev-parse", "HEAD") });
    expect(await readFile(join(integration, "feature.txt"), "utf8")).toBe("new\n");
    expect(git(integration, "status", "--porcelain")).toBe("?? .gjc/");
  });

  test("a merge that would overwrite an untracked file fails with git's message and changes nothing", async () => {
    await writeFile(join(work, "feature.txt"), "incoming\n");
    const captured = await port.capture({
      cwd: work,
      integrationCommit: "goal/integration",
      message: "task",
    });
    await writeFile(join(integration, "feature.txt"), "local untracked\n");
    const before = git(integration, "rev-parse", "HEAD");

    await expect(
      port.merge({ cwd: integration, commit: captured?.headCommit ?? "", message: "Integrate" }),
    ).rejects.toThrow(/git merge failed: .*untracked working tree files would be overwritten/s);

    expect(git(integration, "rev-parse", "HEAD")).toBe(before);
    expect(git(integration, "status", "--porcelain")).toBe("?? feature.txt");
    expect(await readFile(join(integration, "feature.txt"), "utf8")).toBe("local untracked\n");
    expect(() => git(integration, "rev-parse", "-q", "--verify", "MERGE_HEAD")).toThrow();
  });

  test("resetHard returns the branch to an earlier commit and removes new files", async () => {
    const start = git(integration, "rev-parse", "HEAD");
    await writeFile(join(work, "feature.txt"), "new\n");
    const captured = await port.capture({
      cwd: work,
      integrationCommit: "goal/integration",
      message: "task",
    });
    await port.merge({ cwd: integration, commit: captured?.headCommit ?? "", message: "m" });
    await writeFile(join(integration, "untracked.txt"), "x\n");

    await port.resetHard({ cwd: integration, commit: start });

    expect(git(integration, "rev-parse", "HEAD")).toBe(start);
    expect(git(integration, "status", "--porcelain")).toBe("");
  });

  test("runCommand reports exit code and output, and kills a command that overruns", async () => {
    const ok = await port.runCommand({ cwd: repo, command: "echo hello", timeoutMs: 5000 });
    expect(ok).toMatchObject({ exitCode: 0, timedOut: false });
    expect(ok.output).toContain("hello");

    const failed = await port.runCommand({
      cwd: repo,
      command: "echo broke >&2; exit 3",
      timeoutMs: 5000,
    });
    expect(failed).toMatchObject({ exitCode: 3, timedOut: false });
    expect(failed.output).toContain("broke");

    const started = Date.now();
    const slow = await port.runCommand({ cwd: repo, command: "sleep 30", timeoutMs: 200 });
    expect(slow.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("capture and merge keep working when Paseo renames the integration branch", async () => {
    const integrationHead = git(integration, "rev-parse", "HEAD");
    // Paseo's branch auto-namer renames a worktree's branch after creation.
    git(integration, "branch", "-m", "goal/integration", "renamed-by-namer");

    await writeFile(join(work, "feature.txt"), "new\n");
    const captured = await port.capture({
      cwd: work,
      integrationCommit: integrationHead,
      message: "task",
    });
    expect(captured?.baseCommit).toBe(integrationHead);

    const merged = await port.merge({
      cwd: integration,
      commit: captured?.headCommit ?? "",
      message: "m",
    });
    expect(merged.ok).toBe(true);
    expect(await port.currentBranch(integration)).toBe("renamed-by-namer");
  });

  test("isClean sees untracked and modified files", async () => {
    expect(await port.isClean(work)).toBe(true);
    await writeFile(join(work, "stray.txt"), "x\n");
    expect(await port.isClean(work)).toBe(false);
  });

  test("resolveCommit gives the full id of a commit id, and null for refs and anything else", async () => {
    await writeFile(join(integration, "merged.txt"), "x\n");
    git(integration, "add", "-A");
    git(integration, "-c", "commit.gpgsign=false", "commit", "-m", "integration work");
    const head = git(integration, "rev-parse", "HEAD");
    const tree = git(integration, "rev-parse", "HEAD^{tree}");
    // A follow-up goal runs in the project checkout; it shares the integration worktree's objects.
    expect(await port.resolveCommit(repo, head)).toBe(head);
    expect(await port.resolveCommit(repo, head.slice(0, 12).toUpperCase())).toBe(head);
    expect(await port.resolveCommit(repo, "0".repeat(40))).toBeNull();
    // Too short, not a commit, a ref name and an option are never looked up as commits.
    expect(await port.resolveCommit(repo, head.slice(0, 6))).toBeNull();
    expect(await port.resolveCommit(repo, tree)).toBeNull();
    expect(await port.resolveCommit(repo, "main")).toBeNull();
    expect(await port.resolveCommit(repo, "--all")).toBeNull();
    expect(await port.resolveCommit(repo, `${head} HEAD`)).toBeNull();
  });

  test("resolveCommit refuses a branch whose name looks like a commit id", async () => {
    const initial = git(repo, "rev-parse", "HEAD");
    // Hex names that are not a prefix of the commit they point at.
    const names = ["abcd1234", "cafe1234", "2026102"].filter((name) => !initial.startsWith(name));
    for (const name of names) {
      git(repo, "branch", name, initial);
      expect(await port.resolveCommit(repo, name)).toBeNull();
    }
    expect(names.length).toBeGreaterThan(0);
  });

  test("trackedChanges lists modified tracked files and ignores untracked ones", async () => {
    expect(await port.trackedChanges(work)).toBe("");
    await writeFile(join(work, "stray.txt"), "x\n");
    expect(await port.trackedChanges(work)).toBe("");
    await writeFile(join(work, "shared.txt"), "changed\n");
    expect(await port.trackedChanges(work)).toBe(" M shared.txt");
  });

  describe("the integration check before a recovery", () => {
    function goalAt(head = git(integration, "rev-parse", "HEAD")): Goal {
      return {
        config: { cwd: repo },
        integration: {
          branch: "goal/integration",
          workspaceId: "ws-int",
          cwd: integration,
          baseCommit: head,
          headCommit: head,
        },
      } as unknown as Goal;
    }

    test("a clean worktree, or one with only untracked files, passes", async () => {
      expect(await integrationProblem(goalAt(), port)).toBeNull();
      await writeFile(join(integration, "cache.tmp"), "x\n");
      expect(await integrationProblem(goalAt(), port)).toBeNull();
    });

    test("a modified, staged or renamed tracked file is named", async () => {
      await writeFile(join(integration, "shared.txt"), "changed\n");
      expect(await integrationProblem(goalAt(), port)).toContain("\n M shared.txt\n");
      git(integration, "add", "shared.txt");
      expect(await integrationProblem(goalAt(), port)).toContain("\nM  shared.txt\n");
      git(integration, "reset", "--hard");
      git(integration, "mv", "shared.txt", "moved.txt");
      expect(await integrationProblem(goalAt(), port)).toContain("R  shared.txt -> moved.txt");
    });

    test("a path git quotes keeps its non-ASCII letters readable", async () => {
      // git's default core.quotePath would print octal escapes; the port reads paths verbatim.
      git(repo, "config", "core.quotePath", "true");
      await writeFile(join(integration, "naïve file.txt"), "a\n");
      git(integration, "add", "-A");
      git(integration, "-c", "commit.gpgsign=false", "commit", "-m", "add");
      await writeFile(join(integration, "naïve file.txt"), "b\n");
      expect(await integrationProblem(goalAt(), port)).toContain(' M "naïve file.txt"');
    });

    test("a submodule with changes inside it counts as a tracked change", async () => {
      const sub = join(root, "sub");
      execFileSync("git", ["init", "-b", "main", sub], { stdio: "pipe" });
      git(sub, "config", "user.email", "test@example.com");
      git(sub, "config", "user.name", "Test");
      await writeFile(join(sub, "lib.txt"), "1\n");
      git(sub, "add", "-A");
      git(sub, "-c", "commit.gpgsign=false", "commit", "-m", "lib");
      git(integration, "-c", "protocol.file.allow=always", "submodule", "add", sub, "vendor");
      git(integration, "-c", "commit.gpgsign=false", "commit", "-m", "submodule");
      await writeFile(join(integration, "vendor", "lib.txt"), "2\n");
      expect(await integrationProblem(goalAt(), port)).toContain(" M vendor");
    });

    test("a head that moved names both commits; a missing worktree says how to recreate it", async () => {
      const recorded = git(integration, "rev-parse", "HEAD");
      await writeFile(join(integration, "extra.txt"), "x\n");
      git(integration, "add", "-A");
      git(integration, "-c", "commit.gpgsign=false", "commit", "-m", "extra");
      const moved = git(integration, "rev-parse", "HEAD");
      expect(await integrationProblem(goalAt(recorded), port)).toContain(
        `is at ${moved}, but the goal recorded ${recorded} on goal/integration`,
      );
      await rm(integration, { recursive: true, force: true });
      expect(await integrationProblem(goalAt(recorded), port)).toContain(
        `The integration worktree ${integration} is missing. Recreate it on its branch: git -C ${repo} worktree prune && git -C ${repo} worktree add ${integration} goal/integration`,
      );
    });

    test("paths with spaces or quotes are quoted in the commands", () => {
      expect(shellQuote("/tmp/a b")).toBe("'/tmp/a b'");
      expect(shellQuote("it's")).toBe("'it'\\''s'");
      expect(shellQuote("/plain/path-1.2")).toBe("/plain/path-1.2");
    });
  });
});
