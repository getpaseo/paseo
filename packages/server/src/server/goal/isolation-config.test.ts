import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createGoalConfigValidator } from "./goal-config-validation.js";
import type { GitButlerDetection } from "./gitbutler.js";
import { CONFIG, createGoalTestEnv, task, type GoalTestEnv } from "./goal-test-env.js";
import { buildTaskPrompt } from "./prompts.js";
import type { Goal } from "@getpaseo/protocol/goal/types";

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
    });
    await expect(managed({ ...CONFIG, isolation: "auto" })).resolves.toMatchObject({
      isolation: "workspace",
    });

    const plain = validatorFor({ cliInstalled: true, repositoryManaged: false });
    await expect(plain(CONFIG)).resolves.toMatchObject({ isolation: "worktree", maxParallel: 2 });
  });

  test("a goal that works in the checkout refuses a base commit other than its HEAD", async () => {
    const validate = createGoalConfigValidator({
      git: { head: async () => "abc", resolveCommit: async (_cwd, ref) => `${ref}-full` },
      knownProviders: () => ["claude", "codex"],
      detectGitButler: async () => ({ cliInstalled: true, repositoryManaged: true }),
    });
    await expect(
      validate({ ...CONFIG, isolation: "workspace", baseCommit: "1234567" }),
    ).rejects.toThrow(/not the checkout's HEAD/);
    await expect(
      validate({ ...CONFIG, isolation: "worktree", baseCommit: "1234567" }),
    ).resolves.toMatchObject({ isolation: "worktree", baseCommit: "1234567-full" });
  });

  test("auto keeps worktrees when GitButler manages the repository but the CLI is missing", async () => {
    const validate = validatorFor({ cliInstalled: false, repositoryManaged: true });
    await expect(validate(CONFIG)).resolves.toMatchObject({ isolation: "worktree" });
  });

  test("a stated mode is kept and so is the parallelism asked for", async () => {
    const managed = validatorFor({ cliInstalled: true, repositoryManaged: true });
    await expect(managed({ ...CONFIG, isolation: "worktree" })).resolves.toMatchObject({
      isolation: "worktree",
      maxParallel: 2,
    });
    const plain = validatorFor({ cliInstalled: false, repositoryManaged: false });
    await expect(plain({ ...CONFIG, isolation: "workspace" })).resolves.toMatchObject({
      isolation: "workspace",
      maxParallel: 2,
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

  test("a checkout GitButler can no longer read leaves the work uncommitted and the goal running", async () => {
    const git = env.harness.git;
    git.snapshotWorkspace = async () => ({});
    git.commitWorkspaceChanges = async () => {
      throw new Error("Setup required: Not currently on a gitbutler/* branch");
    };
    env.script([task("a")]);
    const booted = await env.boot();
    await env.createGoal(booted.store, { ...CONFIG, isolation: "workspace", maxParallel: 1 });
    await env.settle(booted.manager);
    const goal = env.goalOf(booted.store);
    expect(goal.tasks[0]?.status).toBe("succeeded");
    expect(goal.status).not.toBe("failed");
  });
});

describe("worker prompt by isolation", () => {
  const workspaceGoal = { config: { ...CONFIG, isolation: "workspace" } } as unknown as Goal;
  const worktreeGoal = { config: { ...CONFIG, isolation: "worktree" } } as unknown as Goal;
  const implement = { kind: "implement", dependsOn: [], title: "t", description: "d" } as never;

  test("workspace tells the worker not to commit, branch or use worktrees", () => {
    const prompt = buildTaskPrompt(workspaceGoal, implement);
    expect(prompt).toContain("leave it uncommitted");
    expect(prompt).toContain("git worktree");
    expect(prompt).not.toContain("own git worktree. Make the change and commit");
  });

  test("worktree keeps asking the worker to commit in its own worktree", () => {
    expect(buildTaskPrompt(worktreeGoal, implement)).toContain(
      "own git worktree. Make the change and commit",
    );
  });
});

const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const DONE = { outcome: "completed", text: "done" } as const;

describe("tasks sharing one checkout", () => {
  let env: GoalTestEnv;

  beforeEach(async () => {
    env = createGoalTestEnv();
    await env.init();
  });
  afterEach(() => env.cleanup());

  async function start(tasks: unknown[]) {
    env.script(tasks, () => "hold");
    const booted = await env.boot();
    await env.createGoal(booted.store, { ...CONFIG, isolation: "workspace", maxParallel: 2 });
    await tick(150);
    return booted;
  }

  test("tasks with different paths run together", async () => {
    await start([task("a", { touches: ["a/"] }), task("b", { touches: ["b/"] })]);
    expect(env.harness.turns).toHaveLength(2);
  });

  test("a task waits for a running one that may change the same files", async () => {
    await start([task("a", { touches: ["src/"] }), task("b", { touches: ["src/x.ts"] })]);
    expect(env.harness.turns).toHaveLength(1);
    env.harness.turns[0]?.resolve(DONE);
    await tick(150);
    expect(env.harness.turns).toHaveLength(2);
  });

  test("a task that declared no paths runs alone", async () => {
    await start([task("a"), task("b", { touches: ["b/"] })]);
    expect(env.harness.turns).toHaveLength(1);
    env.harness.turns[0]?.resolve(DONE);
    await tick(150);
    expect(env.harness.turns).toHaveLength(2);
  });

  test("worktree goals never wait for each other", async () => {
    env.script([task("a"), task("b")], () => "hold");
    const booted = await env.boot();
    await env.createGoal(booted.store, { ...CONFIG, isolation: "worktree", maxParallel: 2 });
    await tick(150);
    expect(env.harness.turns).toHaveLength(2);
  });
});

describe("the checkout is shared", () => {
  let env: GoalTestEnv;

  beforeEach(async () => {
    env = createGoalTestEnv();
    await env.init();
  });
  afterEach(() => env.cleanup());

  test("two goals in the same checkout do not run tasks over the same paths together", async () => {
    env.script([task("a", { touches: ["a/"] })], () => "hold");
    const booted = await env.boot();
    const config = { ...CONFIG, isolation: "workspace", maxParallel: 2 } as const;
    await env.createGoal(booted.store, config, "g1");
    await env.createGoal(booted.store, config, "g2");
    await tick(200);
    expect(env.harness.turns).toHaveLength(1);
    env.harness.turns[0]?.resolve(DONE);
    await tick(200);
    expect(env.harness.turns).toHaveLength(2);
  });

  test("a verifier that changes the checkout has its verdict discarded and nothing reset", async () => {
    const git = env.harness.git;
    let reads = 0;
    git.snapshotWorkspace = async () => {
      reads += 1;
      // The task's snapshot, the verifier's baseline, then what the verifier left behind.
      return reads >= 3 ? { "src/fixed.ts": "edited" } : {};
    };
    git.commitWorkspaceChanges = async () => null;
    env.script([task("a")]);
    const booted = await env.boot();
    await env.createGoal(booted.store, { ...CONFIG, isolation: "workspace", maxParallel: 1 });
    await env.settle(booted.manager);
    const goal = env.goalOf(booted.store);
    expect(goal.status).toBe("failed");
    expect(goal.failureReason).toMatch(/verifier changed src\/fixed\.ts in the checkout/);
  });
});
