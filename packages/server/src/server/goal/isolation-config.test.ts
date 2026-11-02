import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createGoalConfigValidator } from "./goal-config-validation.js";
import type { GitButlerDetection } from "./gitbutler.js";
import { CONFIG, createGoalTestEnv, task, type GoalTestEnv } from "./goal-test-env.js";

function validatorFor(found: GitButlerDetection) {
  return createGoalConfigValidator({
    git: { head: async () => "abc", resolveCommit: async () => null },
    knownProviders: () => ["claude", "codex"],
    detectGitButler: async () => found,
  });
}

describe("goal isolation", () => {
  test("auto picks the checkout for a GitButler repository and a worktree otherwise", async () => {
    const managed = validatorFor({ cliInstalled: true, repositoryManaged: true });
    await expect(managed(CONFIG)).resolves.toMatchObject({
      isolation: "workspace",
      maxParallel: 1,
    });
    await expect(managed({ ...CONFIG, isolation: "auto" })).resolves.toMatchObject({
      isolation: "workspace",
    });

    const plain = validatorFor({ cliInstalled: true, repositoryManaged: false });
    await expect(plain(CONFIG)).resolves.toMatchObject({ isolation: "worktree", maxParallel: 2 });
  });

  test("auto keeps worktrees when GitButler manages the repository but the CLI is missing", async () => {
    const validate = validatorFor({ cliInstalled: false, repositoryManaged: true });
    await expect(validate(CONFIG)).resolves.toMatchObject({ isolation: "worktree" });
  });

  test("a stated mode is kept, and workspace runs one task at a time", async () => {
    const managed = validatorFor({ cliInstalled: true, repositoryManaged: true });
    await expect(managed({ ...CONFIG, isolation: "worktree" })).resolves.toMatchObject({
      isolation: "worktree",
      maxParallel: 2,
    });
    const plain = validatorFor({ cliInstalled: false, repositoryManaged: false });
    await expect(plain({ ...CONFIG, isolation: "workspace" })).resolves.toMatchObject({
      isolation: "workspace",
      maxParallel: 1,
    });
  });
});

describe("goal in the workspace", () => {
  let env: GoalTestEnv;

  beforeEach(async () => {
    env = createGoalTestEnv();
    await env.init();
  });
  afterEach(() => env.cleanup());

  test("the Lead and the tasks run in the checkout and no integration worktree is made", async () => {
    env.script([task("a")]);
    const booted = await env.boot();
    await env.createGoal(booted.store, { ...CONFIG, isolation: "workspace", maxParallel: 1 });
    await env.settle(booted.manager);

    const { workspaces } = env.harness;
    expect(workspaces.length).toBeGreaterThan(0);
    expect(workspaces.every((w) => w.isolation === "reference")).toBe(true);
    expect(workspaces.some((w) => w.title.endsWith("(integration)"))).toBe(false);
    const goal = env.goalOf(booted.store);
    expect(goal.integration ?? null).toBeNull();
    expect(goal.changeSets).toHaveLength(0);
    expect(goal.tasks[0]?.status).toBe("succeeded");
  });

  test("a goal without isolation keeps cutting a worktree per agent", async () => {
    env.script([task("a")]);
    const booted = await env.boot();
    await env.createGoal(booted.store, CONFIG);
    await env.settle(booted.manager);
    expect(env.harness.workspaces.every((w) => w.isolation === "worktree")).toBe(true);
  });

  test("a task's work goes to a branch of its own when the checkout can be committed to", async () => {
    const calls: string[] = [];
    const git = env.harness.git;
    git.snapshotWorkspace = async () => ({ "mine.txt": "h" });
    git.commitWorkspaceChanges = async (input) => {
      calls.push(`${input.branch}|${Object.keys(input.before).join(",")}|${input.message}`);
      return { branch: input.branch, files: ["x.ts"] };
    };
    env.script([task("a")]);
    const booted = await env.boot();
    await env.createGoal(booted.store, { ...CONFIG, isolation: "workspace", maxParallel: 1 });
    await env.settle(booted.manager);
    expect(calls).toEqual(["paseo-goal/g1-a|mine.txt|Task a: Task a"]);
    expect(env.goalOf(booted.store).tasks[0]?.status).toBe("succeeded");
  });
});
