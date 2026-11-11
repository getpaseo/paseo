import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { GoalConfig } from "@getpaseo/protocol/goal/types";
import { CONFIG, createGoalTestEnv, task, type GoalTestEnv } from "./goal-test-env.js";

const APPROVE = JSON.stringify({ verdict: "approve", findings: [] });
const REQUEST = (...findings: string[]) => JSON.stringify({ verdict: "request_changes", findings });
const POLICY: GoalConfig = { ...CONFIG, policyPaths: ["src/auth/"] };

describe("integrated review of merges that change policy paths", () => {
  let env: GoalTestEnv;

  beforeEach(async () => {
    env = createGoalTestEnv();
    await env.init();
  });
  afterEach(() => env.cleanup());

  const h = () => env.harness;
  const reviewers = () => h().agents.filter((a) => a.labels["paseo.goal-role"] === "reviewer");
  const prompts: string[] = [];

  function reviewWith(answer: (call: number, prompt: string) => string) {
    let calls = 0;
    prompts.length = 0;
    env.stageReplies.review = (turn) => {
      calls += 1;
      prompts.push(turn.prompt);
      return { outcome: "completed", text: env.fenced(answer(calls, turn.prompt)) };
    };
  }

  async function run(config: GoalConfig) {
    const { store, manager } = await env.boot();
    await env.createGoal(store, config);
    await env.settle(manager);
    return env.goalOf(store);
  }

  test("a merge that changes a policy path is reviewed again on the integration branch, and the approval names that commit", async () => {
    env.script([task("a")]);
    h().git.changedByCommit.set("merged-1", ["src/auth/roles.ts", "src/other.ts"]);
    reviewWith(() => APPROVE);

    const g = await run(POLICY);

    expect(g.status).toBe("completed");
    expect(reviewers()).toHaveLength(2);
    const integrated = reviewers()[1];
    expect(integrated).toMatchObject({
      cwd: g.integration?.cwd,
      workspaceId: g.integration?.workspaceId,
    });
    expect(prompts[1]).toContain("src/auth/roles.ts");
    expect(prompts[1]).not.toContain("src/other.ts\n");
    expect(g.changeSets[0]).toMatchObject({
      status: "integrated",
      integratedCommit: "merged-1",
      integrationReviewedCommit: "merged-1",
    });
  });

  test("a merge that leaves the policy paths alone is reviewed once", async () => {
    env.script([task("a")]);
    h().git.changedByCommit.set("merged-1", ["src/feature.ts"]);
    reviewWith(() => APPROVE);

    const g = await run(POLICY);

    expect(g.status).toBe("completed");
    expect(reviewers()).toHaveLength(1);
    expect(g.changeSets[0]?.integrationReviewedCommit).toBeUndefined();
  });

  test("without policyPaths no merge gets a second review", async () => {
    env.script([task("a")]);
    h().git.changedByCommit.set("merged-1", ["src/auth/roles.ts"]);
    reviewWith(() => APPROVE);

    const g = await run(CONFIG);

    expect(reviewers()).toHaveLength(1);
    expect(g.changeSets[0]?.integrationReviewedCommit).toBeUndefined();
  });

  test("requested changes put the branch back and send the change to rework with the findings", async () => {
    env.script([task("a")]);
    h().git.changedByCommit.set("merged-1", ["src/auth/roles.ts"]);
    reviewWith((call) => (call === 2 ? REQUEST("admin role can now read other squads") : APPROVE));

    const g = await run(POLICY);

    expect(g.status).toBe("completed");
    expect(g.changeSets[0]).toMatchObject({ status: "superseded", integratedCommit: null });
    expect(g.changeSets[0]?.findings).toContain("admin role can now read other squads");
    expect(g.tasks.find((t) => t.id === "a-rw1")?.rework?.reason).toBe("review");
    // The branch went back to where it was before the rejected merge.
    expect(h().git.resets).toContainEqual({ cwd: g.integration?.cwd, commit: "base0" });
    expect(g.changeSets[1]?.status).toBe("integrated");
  });
});
