import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { goalRoleThinking } from "@getpaseo/protocol/goal/thinking";
import { GoalSchema, type GoalConfig } from "@getpaseo/protocol/goal/types";
import type { AgentModelDefinition } from "../agent/agent-sdk-types.js";
import { createGoalConfigValidator } from "./goal-config-validation.js";
import { CONFIG, createGoalTestEnv, task, type GoalTestEnv } from "./goal-test-env.js";

const option = (id: string) => ({ id, label: id });

const CATALOG: Record<string, AgentModelDefinition[]> = {
  codex: [
    {
      provider: "codex",
      id: "gpt-big",
      label: "Big",
      isDefault: true,
      thinkingOptions: [option("low"), option("high")],
    },
    { provider: "codex", id: "gpt-mini", label: "Mini", aliases: ["mini"] },
  ],
  claude: [
    {
      provider: "claude",
      id: "opus",
      label: "Opus",
      isDefault: true,
      thinkingOptions: [option("think"), option("ultrathink")],
    },
  ],
};

function catalog(calls: string[] = []) {
  return async (provider: string): Promise<AgentModelDefinition[]> => {
    calls.push(provider);
    const models = CATALOG[provider];
    if (!models) throw new Error(`Provider ${provider} is not configured`);
    return models;
  };
}

const withConfig = (extra: Partial<GoalConfig>): GoalConfig => ({ ...CONFIG, ...extra });

describe("goal role thinking resolution", () => {
  test("a config without thinking leaves every role on the model's default", () => {
    for (const role of ["lead", "worker", "reviewer", "verifier"] as const) {
      expect(goalRoleThinking(CONFIG, role, task("a"))).toBeUndefined();
    }
  });

  test("each role uses its own setting and never another role's", () => {
    expect(goalRoleThinking(withConfig({ leadThinking: "think" }), "reviewer")).toBeUndefined();
    expect(goalRoleThinking(withConfig({ reviewThinking: "high" }), "verifier")).toBeUndefined();
    const config = withConfig({
      leadThinking: "think",
      reviewThinking: "r",
      verifyThinking: "v",
    });
    expect(goalRoleThinking(config, "lead")).toBe("think");
    expect(goalRoleThinking(config, "reviewer")).toBe("r");
    expect(goalRoleThinking(config, "verifier")).toBe("v");
  });

  test("a worker takes the task's thinking, then workerThinking on defaultProvider, then nothing", () => {
    const config = withConfig({ workerThinking: "high" });
    expect(goalRoleThinking(config, "worker", { thinking: "low" })).toBe("low");
    expect(goalRoleThinking(config, "worker", {})).toBe("high");
    expect(goalRoleThinking(config, "worker", { provider: "codex" })).toBe("high");
    // Another provider's model has its own options, so workerThinking does not follow it.
    expect(goalRoleThinking(config, "worker", { provider: "claude" })).toBeUndefined();
    expect(goalRoleThinking(config, "worker", { provider: "codex/gpt-mini" })).toBeUndefined();
    expect(goalRoleThinking(config, "worker", { provider: "claude", thinking: "think" })).toBe(
      "think",
    );
  });
});

describe("goal thinking validation", () => {
  function validator(calls: string[] = [], modelCatalog = catalog(calls)) {
    return createGoalConfigValidator({
      git: { head: async () => "abc", resolveCommit: async () => null },
      knownProviders: () => ["claude", "codex"],
      modelCatalog,
    });
  }

  test("a config without thinking never reads the catalog", async () => {
    const calls: string[] = [];
    await expect(validator(calls)(CONFIG)).resolves.toMatchObject({ baseCommit: "abc" });
    expect(calls).toEqual([]);
  });

  test("ids the role's model lists are accepted", async () => {
    await expect(
      validator()(
        withConfig({
          leadThinking: "ultrathink",
          workerThinking: "high",
          reviewProvider: "codex/gpt-big",
          reviewThinking: "low",
          verifyThinking: "low",
        }),
      ),
    ).resolves.toMatchObject({ workerThinking: "high", verifyThinking: "low" });
  });

  test("an id the model does not list is rejected, naming the setting and the choices", async () => {
    await expect(validator()(withConfig({ workerThinking: "ultra" }))).rejects.toThrow(
      'workerThinking "ultra" is not a thinking option of codex/gpt-big. Available: low, high',
    );
    // The reviewer runs on the Lead's provider when reviewProvider is unset.
    await expect(validator()(withConfig({ reviewThinking: "high" }))).rejects.toThrow(
      'reviewThinking "high" is not a thinking option of claude/opus. Available: think, ultrathink',
    );
    // provider/model picks the model, found by id or alias.
    await expect(
      validator()(withConfig({ defaultProvider: "codex/mini", workerThinking: "low" })),
    ).rejects.toThrow("is not a thinking option of codex/gpt-mini. Available: (none)");
  });

  test("an unreadable catalog or an unknown model leaves the id to the provider", async () => {
    await expect(
      validator()(withConfig({ defaultProvider: "codex/unlisted", workerThinking: "x" })),
    ).resolves.toBeDefined();
    const failing = async (): Promise<AgentModelDefinition[]> => {
      throw new Error("still loading");
    };
    await expect(
      validator([], failing)(withConfig({ leadThinking: "anything" })),
    ).resolves.toBeDefined();
    const noCatalog = createGoalConfigValidator({
      git: { head: async () => "abc", resolveCommit: async () => null },
      knownProviders: () => ["claude", "codex"],
    });
    await expect(noCatalog(withConfig({ leadThinking: "anything" }))).resolves.toBeDefined();
  });
});

describe("goal thinking at run time", () => {
  let env: GoalTestEnv;

  beforeEach(async () => {
    env = createGoalTestEnv();
    await env.init();
  });
  afterEach(() => env.cleanup());

  const h = () => env.harness;
  const created = (prefix: string) => h().agents.filter((a) => a.title.startsWith(prefix));

  async function start(config: GoalConfig) {
    const booted = await env.boot();
    await env.createGoal(booted.store, config);
    await env.settle(booted.manager);
    return booted;
  }

  test("each role's agent is created with its thinking, and runs record what they started with", async () => {
    h().providerThinking = "medium";
    env.script([task("a"), task("b", { provider: "claude" }), task("c", { thinking: "low" })]);
    const { store } = await start(
      withConfig({
        leadThinking: "think",
        workerThinking: "high",
        reviewThinking: "r",
        verifyThinking: "v",
      }),
    );

    const goal = env.goalOf(store);
    expect(goal.status).toBe("completed");
    expect(created("Lead:")[0]?.thinking).toBe("think");
    const worker = (id: string) => created(`Ship: Task ${id}`)[0];
    expect(worker("a")?.thinking).toBe("high");
    expect(worker("b")).not.toHaveProperty("thinking");
    expect(worker("c")?.thinking).toBe("low");
    expect(created("Review:").map((a) => a.thinking)).toEqual(["r", "r", "r"]);
    expect(created("Verify:")[0]?.thinking).toBe("v");

    const thinkingOf = (id: string) => goal.runs.find((r) => r.taskId === id)?.thinking;
    expect(thinkingOf("a")).toBe("high");
    // Nothing was asked for, so the run records what the provider reported.
    expect(thinkingOf("b")).toBe("medium");
    expect(thinkingOf("c")).toBe("low");
    expect(goal.tasks.find((t) => t.id === "c")?.thinking).toBe("low");

    // The log carries it, and a restarted daemon replays it.
    const attached = (await env.readEvents()).filter((e) => e.type === "run.attached");
    expect(attached.map((e) => (e.type === "run.attached" ? e.thinking : null))).toEqual(
      expect.arrayContaining(["high", "medium", "low"]),
    );
    const { store: replayed } = await env.boot();
    const again = env.goalOf(replayed);
    expect(GoalSchema.safeParse(again).success).toBe(true);
    expect(again.runs.map((r) => r.thinking)).toEqual(goal.runs.map((r) => r.thinking));
  });

  test("a goal without thinking creates every agent exactly as before", async () => {
    env.script([task("a"), task("b", { provider: "claude" })]);
    const { store } = await start(CONFIG);

    expect(env.goalOf(store).status).toBe("completed");
    expect(h().agents.length).toBeGreaterThan(0);
    for (const agent of h().agents) expect(agent).not.toHaveProperty("thinking");
    for (const run of env.goalOf(store).runs) expect(run).not.toHaveProperty("thinking");
    for (const event of await env.readEvents()) {
      if (event.type === "run.attached") expect(event).not.toHaveProperty("thinking");
    }
  });

  test("a plan naming a thinking id its model lacks goes back to the Lead with the choices", async () => {
    h().agentPort.modelCatalog = catalog();
    env.script([task("a", { thinking: "ultra" })]);
    const scripted = h().respond;
    const prompts: string[] = [];
    h().respond = (turn) => {
      prompts.push(turn.prompt);
      return scripted ? scripted(turn) : "hold";
    };
    const { store } = await start(CONFIG);

    expect(prompts[1]).toContain('Task a thinking "ultra" is not a thinking option');
    expect(h().agents.filter((a) => a.title.startsWith("Ship:"))).toEqual([]);
    const goal = env.goalOf(store);
    expect(goal.status).toBe("failed");
    expect(goal.failureReason).toBe(
      'Lead did not produce a valid plan: Task a thinking "ultra" is not a thinking option of codex/gpt-big. Available: low, high',
    );
  });

  test("a plan thinking id the model lists is accepted and used", async () => {
    h().agentPort.modelCatalog = catalog();
    env.script([task("a", { thinking: "low" })]);
    const { store } = await start(CONFIG);

    expect(env.goalOf(store).status).toBe("completed");
    expect(created("Ship: Task a")[0]?.thinking).toBe("low");
  });
});
