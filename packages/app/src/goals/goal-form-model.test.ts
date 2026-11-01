import { describe, expect, it } from "vitest";
import {
  EMPTY_GOAL_FORM_VALUES,
  buildGoalCreateInput,
  describeGoalOutcome,
  goalRoleModel,
  goalRoleThinkingOptions,
  openGoalForm,
  parseGoalCriteria,
  validateGoalForm,
  type GoalFormValues,
  type GoalProviderOption,
} from "./goal-form-model";
import { goalFormMemoryFromConfig } from "./goal-form-memory";
import { buildGoalProjectOptions } from "./goal-projects";
import { DAEMON_GOAL_SETTINGS, GOAL_PRESETS, NO_GOAL_BUDGET } from "./goal-settings";

function values(overrides: Partial<GoalFormValues>): GoalFormValues {
  return { ...EMPTY_GOAL_FORM_VALUES, ...overrides };
}

const MANAGED: Partial<GoalFormValues> = {
  title: "Rate limiting",
  objective: "Limit the API",
  criteriaText: "Over the limit gets 429",
  managed: true,
  cwd: " /repo ",
  leadProvider: "claude",
  defaultProvider: "codex",
};

describe("parseGoalCriteria", () => {
  it("keeps one trimmed criterion per non-blank line", () => {
    expect(parseGoalCriteria("  Tests pass \r\n\n Docs updated\n   \n")).toEqual([
      "Tests pass",
      "Docs updated",
    ]);
  });
});

describe("buildGoalCreateInput", () => {
  it("cannot submit without a title or an objective", () => {
    expect(buildGoalCreateInput(values({ title: "   ", objective: " " }))).toBeNull();
  });

  it("takes the title from the objective's first line when none is typed", () => {
    expect(
      buildGoalCreateInput(values({ objective: "\nFix the login bug\nIt fails on Safari" }))?.title,
    ).toBe("Fix the login bug");
  });

  it("builds a manual goal without a config", () => {
    expect(
      buildGoalCreateInput(
        values({
          title: " Release 1.0 ",
          objective: " Ship it \n",
          criteriaText: "CI green\nChangelog written",
        }),
      ),
    ).toEqual({
      title: "Release 1.0",
      objective: "Ship it",
      criteria: ["CI green", "Changelog written"],
    });
  });

  it("builds the required config and omits every optional left at the daemon default", () => {
    expect(buildGoalCreateInput(values(MANAGED))).toEqual({
      title: "Rate limiting",
      objective: "Limit the API",
      criteria: ["Over the limit gets 429"],
      config: {
        cwd: "/repo",
        leadProvider: "claude",
        defaultProvider: "codex",
        maxParallel: 2,
        maxAttempts: 2,
        autoApprovePlan: false,
        notifyLead: true,
        // Always sent: an older daemon runs a goal without a policy as `fail`.
        onPermissionRequest: "wait",
      },
    });
  });

  it("sends the wait limit only to a host with goalUserWait", () => {
    const changed = values({
      ...MANAGED,
      settings: { ...DAEMON_GOAL_SETTINGS, userWaitMinutes: 60 },
    });
    expect(buildGoalCreateInput(changed, { userWaitSupported: true })?.config?.limits).toEqual({
      userWaitMinutes: 60,
    });
    expect(buildGoalCreateInput(changed)?.config?.limits).toBeUndefined();
    expect(
      buildGoalCreateInput(changed, { userWaitSupported: false })?.config?.limits,
    ).toBeUndefined();
  });

  it("includes the optionals the user set and the origin chat", () => {
    const input = buildGoalCreateInput(
      values({
        ...MANAGED,
        reviewProvider: "opencode",
        testCommand: " npm test ",
        allowedProviders: ["claude", "codex", "opencode"],
        settings: GOAL_PRESETS.careful,
        budget: { maxTotalTokens: 500_000, maxCostUsd: null },
      }),
      { originAgentId: "agent-1", budgetSupported: true },
    );

    expect(input?.config).toEqual({
      cwd: "/repo",
      leadProvider: "claude",
      defaultProvider: "codex",
      maxParallel: 1,
      maxAttempts: 2,
      autoApprovePlan: false,
      notifyLead: true,
      reviewProvider: "opencode",
      testCommand: "npm test",
      requireHumanApproval: true,
      maxReworkRounds: 1,
      allowedProviders: ["claude", "codex", "opencode"],
      limits: {
        maxTasks: 10,
        maxRuns: 20,
        runTimeoutMinutes: 30,
        goalTimeoutMinutes: 240,
        maxTotalTokens: 500_000,
      },
      onPermissionRequest: "wait",
      originAgentId: "agent-1",
    });
  });

  it("never sends a budget the host cannot enforce", () => {
    const input = buildGoalCreateInput(
      values({ ...MANAGED, budget: { maxTotalTokens: 500_000, maxCostUsd: 5 } }),
    );
    expect(input?.config?.limits).toBeUndefined();
  });

  it("sends a chosen model as provider/model and leaves the review model out without a reviewer", () => {
    expect(
      buildGoalCreateInput(
        values({ ...MANAGED, leadModel: "opus", defaultModel: " ", reviewModel: "stale" }),
      )?.config,
    ).toMatchObject({ leadProvider: "claude/opus", defaultProvider: "codex" });
    const config = buildGoalCreateInput(
      values({ ...MANAGED, reviewProvider: "opencode", reviewModel: "big-model" }),
    )?.config;
    expect(config?.reviewProvider).toBe("opencode/big-model");
  });

  it("does not send managed fields for a manual goal", () => {
    expect(
      buildGoalCreateInput(values({ ...MANAGED, managed: false }), { originAgentId: "agent-1" })
        ?.config,
    ).toBeUndefined();
  });
});

describe("validateGoalForm", () => {
  it("requires a criterion, the working directory and both providers when managed", () => {
    expect(
      validateGoalForm(
        values({
          title: "Goal",
          managed: true,
          criteriaText: " \n ",
          cwd: " ",
          leadProvider: "",
          defaultProvider: "",
        }),
      ),
    ).toEqual([
      { field: "criteria", code: "required" },
      { field: "cwd", code: "required" },
      { field: "leadProvider", code: "required" },
      { field: "defaultProvider", code: "required" },
    ]);
  });

  it("refuses an allow-list that leaves out a provider the goal uses", () => {
    expect(validateGoalForm(values({ ...MANAGED, allowedProviders: ["claude"] }))).toEqual([
      { field: "allowedProviders", code: "excludesRole", provider: "codex" },
    ]);
  });

  it("ignores managed fields while the goal is manual", () => {
    expect(validateGoalForm(values({ title: "Goal", allowedProviders: ["x"] }))).toEqual([]);
  });
});

describe("describeGoalOutcome", () => {
  it("explains what happens after Create", () => {
    expect(describeGoalOutcome(values({}))).toEqual(["manual"]);
    expect(describeGoalOutcome(values({ ...MANAGED, settings: GOAL_PRESETS.turbo }))).toEqual([
      "planAuto",
      "worktrees",
      "mergeReviewed",
      "branch",
    ]);
    expect(describeGoalOutcome(values({ ...MANAGED, settings: GOAL_PRESETS.careful }))).toEqual([
      "planReview",
      "worktrees",
      "mergeAsk",
      "branch",
    ]);
  });
});

describe("openGoalForm", () => {
  it("seeds values from the prefill and derives the create input", () => {
    const model = openGoalForm({
      prefill: {
        title: "Fix login",
        objective: "Fix the login bug",
        managed: true,
        cwd: "/repo",
        leadProvider: "claude",
        defaultProvider: "claude",
        originAgentId: "agent-7",
      },
    });

    expect(model.getState().createInput).toBeNull();
    model.setValue("criteriaText", "Login works");
    expect(model.getState().createInput?.config).toMatchObject({
      cwd: "/repo",
      leadProvider: "claude",
      defaultProvider: "claude",
      originAgentId: "agent-7",
    });
  });

  it("builds on a given commit, and drops it when the goal moves to another host", () => {
    const model = openGoalForm({
      serverId: "host-a",
      prefill: {
        ...MANAGED,
        cwd: "/repo",
        baseCommit: { commit: "abc1234def", goalTitle: "Old goal", branch: "paseo-goal/g1" },
      },
    });
    expect(model.getState().baseCommit).toEqual({
      commit: "abc1234def",
      goalTitle: "Old goal",
      branch: "paseo-goal/g1",
    });
    expect(model.getState().createInput?.config?.baseCommit).toBe("abc1234def");
    // The commit lives in this host's repository; another host does not have it.
    model.setHost("host-b");
    expect(model.getState().baseCommit).toBeNull();
  });

  it("drops the base commit when you pick another project or start from HEAD", () => {
    const prefill = {
      ...MANAGED,
      cwd: "/repo",
      baseCommit: { commit: "abc1234def", goalTitle: "Old goal", branch: null },
    };
    const moved = openGoalForm({ prefill });
    moved.chooseFolder("/repo");
    expect(moved.getState().baseCommit).not.toBeNull();
    moved.chooseFolder("/other");
    expect(moved.getState().baseCommit).toBeNull();
    expect(moved.getState().createInput?.config).not.toHaveProperty("baseCommit");

    const cleared = openGoalForm({ prefill });
    cleared.clearBaseCommit();
    expect(cleared.getState().baseCommit).toBeNull();
    expect(cleared.getState().createInput?.config).not.toHaveProperty("baseCommit");
  });

  it("sends no base commit by default, nor an empty one", () => {
    expect(openGoalForm({ prefill: MANAGED }).getState().createInput?.config).not.toHaveProperty(
      "baseCommit",
    );
    const blank = openGoalForm({
      prefill: { ...MANAGED, baseCommit: { commit: " ", goalTitle: "x", branch: null } },
    });
    expect(blank.getState().baseCommit).toBeNull();
    expect(blank.getState().createInput?.config).not.toHaveProperty("baseCommit");
  });

  it("starts from a preset, then the prefilled settings, then your own, then the defaults", () => {
    const mine = { ...GOAL_PRESETS.turbo, maxParallel: 6 };
    expect(openGoalForm({ prefill: { preset: "careful" } }).getState().settingsChoice).toBe(
      "careful",
    );
    expect(
      openGoalForm({ prefill: { settings: { maxParallel: 99 } } }).getState().values.settings
        .maxParallel,
    ).toBe(8);
    expect(openGoalForm({ personalSettings: mine }).getState().settingsChoice).toBe("mine");
    expect(openGoalForm({}).getState().values.settings).toEqual(DAEMON_GOAL_SETTINGS);
  });

  it("defaults to Ask me and sends auto only to a host that takes it", () => {
    const prefill = {
      managed: true,
      title: "Ship",
      criteriaText: "Works",
      cwd: "/repo",
      leadProvider: "claude",
      defaultProvider: "claude",
    };
    expect(openGoalForm({ prefill }).getState().createInput?.config?.onPermissionRequest).toBe(
      "wait",
    );
    const supported = openGoalForm({ prefill, autoPermissionSupported: true });
    supported.setSetting("onPermissionRequest", "auto");
    expect(supported.getState().createInput?.config?.onPermissionRequest).toBe("auto");
    const remembered = { ...DAEMON_GOAL_SETTINGS, onPermissionRequest: "auto" as const };
    const older = openGoalForm({ prefill, personalSettings: remembered });
    expect(older.getState().values.settings.onPermissionRequest).toBe("wait");
    expect(older.getState().createInput?.config?.onPermissionRequest).toBe("wait");
  });

  it("switches to custom on an edit and back with a preset", () => {
    const model = openGoalForm({ prefill: { managed: true, preset: "balanced" } });
    model.stepSetting("maxParallel", 1);
    expect(model.getState().settingsChoice).toBe("custom");
    expect(model.getState().summary[0]).toEqual({ key: "parallel", n: 3 });
    model.chooseSettings("turbo");
    expect(model.getState().values.settings).toEqual(GOAL_PRESETS.turbo);
    model.setSetting("requireHumanApproval", true);
    expect(model.getState().outcome).toContain("mergeAsk");
  });

  it("steps the budget from no cap", () => {
    const model = openGoalForm({ budgetSupported: true });
    model.stepBudget("maxCostUsd", 1);
    model.stepBudget("maxCostUsd", 1);
    expect(model.getState().values.budget).toEqual({ maxTotalTokens: null, maxCostUsd: 2 });
  });

  it("sets a typed budget and clears it back to no cap", () => {
    const model = openGoalForm({ prefill: { managed: true, cwd: "/repo" }, budgetSupported: true });
    model.setBudget("maxCostUsd", 12.5);
    expect(model.getState().values.budget).toEqual({ maxTotalTokens: null, maxCostUsd: 12.5 });
    model.setBudget("maxCostUsd", null);
    expect(model.getState().values.budget).toEqual(NO_GOAL_BUDGET);
  });

  it("shows an issue once its field is touched, and every issue after a submit attempt", () => {
    const model = openGoalForm({ prefill: { managed: true, title: "x" } });
    expect(model.getState().visibleIssues).toEqual([]);
    model.setValue("cwd", "");
    expect(model.getState().visibleIssues).toEqual([{ field: "cwd", code: "required" }]);
    model.attemptSubmit();
    expect(model.getState().visibleIssues.map((issue) => issue.field)).toEqual([
      "criteria",
      "cwd",
      "leadProvider",
      "defaultProvider",
    ]);
  });

  it("fills the providers from the host's first provider once providers arrive", () => {
    const model = openGoalForm({ prefill: { managed: true } });
    model.applyProviderOptions([
      { id: "codex", label: "Codex" },
      { id: "claude", label: "Claude" },
    ]);
    expect(model.getState().values).toMatchObject({
      leadProvider: "codex",
      defaultProvider: "codex",
    });
  });

  it("replaces a prefilled provider the host has not registered", () => {
    const model = openGoalForm({
      prefill: { managed: true, leadProvider: "custom-acp", defaultProvider: "claude" },
    });

    model.applyProviderOptions([]);
    expect(model.getState().values.leadProvider).toBe("custom-acp");

    model.applyProviderOptions([
      { id: "codex", label: "Codex" },
      { id: "claude", label: "Claude" },
    ]);
    expect(model.getState().values).toMatchObject({
      leadProvider: "claude",
      defaultProvider: "claude",
    });
  });

  it("keeps the allow-list to registered providers and fills roles from it", () => {
    const model = openGoalForm({
      prefill: { managed: true, allowedProviders: ["gone", "claude"] },
    });
    model.applyProviderOptions([
      { id: "codex", label: "Codex" },
      { id: "claude", label: "Claude" },
    ]);
    expect(model.getState().values).toMatchObject({
      allowedProviders: ["claude"],
      leadProvider: "claude",
    });
    model.toggleAllowedProvider("claude");
    expect(model.getState().values.allowedProviders).toEqual([]);
  });

  it("splits a prefilled provider/model into the provider and model pickers", () => {
    const model = openGoalForm({
      prefill: { managed: true, leadProvider: "codex/some-model", defaultProvider: "claude" },
    });
    expect(model.getState().values).toMatchObject({
      leadProvider: "codex",
      leadModel: "some-model",
      defaultProvider: "claude",
      defaultModel: "",
    });
  });

  it("resets a role's model when its provider changes", () => {
    const model = openGoalForm({ prefill: { managed: true, leadProvider: "claude/opus" } });
    model.setValue("leadProvider", "claude");
    expect(model.getState().values.leadModel).toBe("opus");
    model.setValue("reviewModel", "kept");
    model.setValue("leadProvider", "codex");
    expect(model.getState().values).toMatchObject({ leadModel: "", reviewModel: "kept" });
  });

  it("drops a model its provider does not list once providers arrive, and keeps listed ones", () => {
    const model = openGoalForm({
      prefill: { managed: true, leadProvider: "claude/retired", defaultProvider: "codex/fast" },
    });
    model.applyProviderOptions([
      { id: "claude", label: "Claude", models: [{ id: "opus", label: "Opus" }] },
      { id: "codex", label: "Codex", models: [{ id: "fast", label: "Fast" }] },
    ]);
    expect(model.getState().values).toMatchObject({
      leadProvider: "claude",
      leadModel: "",
      defaultProvider: "codex",
      defaultModel: "fast",
    });

    const unlisted = openGoalForm({ prefill: { managed: true, leadProvider: "claude/custom" } });
    unlisted.applyProviderOptions([{ id: "claude", label: "Claude", models: [] }]);
    expect(unlisted.getState().values.leadModel).toBe("custom");
  });

  it("clears the submit error on the next edit and stops publishing after close", () => {
    const model = openGoalForm({});
    let notified = 0;
    model.subscribe(() => {
      notified += 1;
    });

    model.setSubmitError("cwd is not a git repository");
    expect(model.getState().submitError).toBe("cwd is not a git repository");
    model.setValue("cwd", "/other");
    expect(model.getState().submitError).toBeNull();
    expect(notified).toBe(2);

    model.close();
    model.setValue("title", "ignored");
    expect(model.getState().values.title).toBe("");
    expect(notified).toBe(2);
  });
});

describe("project and host", () => {
  const memoryByServer = {
    "host-a": goalFormMemoryFromConfig(
      {
        cwd: "/code/api",
        maxParallel: 2,
        maxAttempts: 2,
        autoApprovePlan: false,
        notifyLead: true,
        leadProvider: "claude",
        defaultProvider: "codex",
        testCommand: "npm test",
      },
      DAEMON_GOAL_SETTINGS,
    ),
    "host-b": goalFormMemoryFromConfig(
      {
        cwd: "/srv/web",
        maxParallel: 1,
        maxAttempts: 2,
        autoApprovePlan: false,
        notifyLead: true,
        leadProvider: "opencode",
        defaultProvider: "opencode",
      },
      GOAL_PRESETS.careful,
    ),
  };
  const projects = buildGoalProjectOptions({
    projects: [
      {
        projectId: "api",
        projectDisplayName: "api",
        projectRootPath: "/code/api",
        projectKind: "git",
      },
      {
        projectId: "cli",
        projectDisplayName: "cli",
        projectRootPath: "/code/cli",
        projectKind: "git",
      },
    ],
    workspaces: [
      {
        projectId: "cli",
        workspaceDirectory: "/worktrees/cli/fix",
        lastUserMessageAt: new Date("2026-06-01T00:00:00Z"),
        createdAt: null,
      },
    ],
  });

  it("opens on the directory it was given, over the host's remembered project", () => {
    const state = openGoalForm({
      serverId: "host-a",
      prefill: { cwd: "/worktrees/cli/fix", originAgentId: "agent-1" },
      memoryByServer,
    }).getState();
    expect(state.values).toMatchObject({
      cwd: "/worktrees/cli/fix",
      leadProvider: "claude",
      managed: true,
      testCommand: "",
    });
    expect(state.cwdSource).toBe("prefill");
  });

  it("opens on the host's remembered project without a given directory", () => {
    const state = openGoalForm({ serverId: "host-a", memoryByServer }).getState();
    expect(state.values).toMatchObject({ cwd: "/code/api", testCommand: "npm test" });
    expect(state.cwdSource).toBe("memory");
    expect(state.projectDisplay).toEqual({ label: "api", path: "/code/api" });
  });

  it("names a given worktree by its project once the projects arrive, and keeps the directory", () => {
    const model = openGoalForm({
      serverId: "host-a",
      prefill: { cwd: "/worktrees/cli/fix" },
      memoryByServer,
    });
    expect(model.getState().projectDisplay).toEqual({ label: "fix", path: "/worktrees/cli/fix" });
    model.applyProjectOptions(projects);
    expect(model.getState()).toMatchObject({
      selectedProjectId: "cli",
      projectDisplay: { label: "cli", path: "/worktrees/cli/fix" },
      values: { cwd: "/worktrees/cli/fix" },
    });
  });

  it("fills an empty directory with the most recently used project", () => {
    const model = openGoalForm({ serverId: "host-new", memoryByServer: {} });
    expect(model.getState().values.cwd).toBe("");
    model.applyProjectOptions(projects);
    expect(model.getState()).toMatchObject({
      values: { cwd: "/code/cli" },
      cwdSource: "recent",
      projectDisplay: { label: "cli", path: "/code/cli" },
    });
  });

  it("runs a chosen project in its checkout and a chosen folder where it is", () => {
    const model = openGoalForm({ serverId: "host-a", memoryByServer });
    model.applyProjectOptions(projects);
    model.chooseProject("cli");
    expect(model.getState()).toMatchObject({
      values: { cwd: "/code/cli" },
      cwdSource: "manual",
      selectedProjectId: "cli",
    });
    model.chooseFolder(" /tmp/scratch ");
    expect(model.getState()).toMatchObject({
      values: { cwd: "/tmp/scratch" },
      selectedProjectId: null,
      projectDisplay: { label: "scratch", path: "/tmp/scratch" },
    });
  });

  it("refuses a directory the host says is not under git, at once, and ignores stale answers", () => {
    const model = openGoalForm({ prefill: { ...MANAGED, cwd: "/plain" } });
    model.applyCwdCheck({ cwd: "/elsewhere", status: "notGit" });
    expect(model.getState().issues).toEqual([]);
    model.applyCwdCheck({ cwd: "/plain", status: "notGit" });
    expect(model.getState().visibleIssues).toEqual([{ field: "cwd", code: "notGitRepo" }]);
    expect(model.getState().createInput).toBeNull();
    model.setValue("cwd", "/repo");
    expect(model.getState().cwdCheck).toBeNull();
    expect(model.getState().createInput?.config?.cwd).toBe("/repo");
  });

  it("moves to another host with that host's remembered project and providers", () => {
    const model = openGoalForm({
      serverId: "host-a",
      prefill: { objective: "Ship it", cwd: "/code/api", originAgentId: "agent-1" },
      memoryByServer,
    });
    model.applyHosts([
      {
        serverId: "host-a",
        label: "A",
        budgetSupported: false,
        thinkingSupported: false,
        userWaitSupported: false,
        autoPermissionSupported: false,
      },
      {
        serverId: "host-b",
        label: "B",
        budgetSupported: true,
        thinkingSupported: true,
        userWaitSupported: true,
        autoPermissionSupported: true,
      },
    ]);
    model.applyProjectOptions(projects);
    model.setHost("host-b");
    expect(model.getState()).toMatchObject({
      serverId: "host-b",
      originAgentId: null,
      budgetSupported: true,
      projectOptions: [],
      providerOptions: [],
      personalSettings: GOAL_PRESETS.careful,
      cwdSource: "memory",
      values: {
        objective: "Ship it",
        cwd: "/srv/web",
        leadProvider: "opencode",
        defaultProvider: "opencode",
        testCommand: "",
      },
    });
  });
});

describe("thinking per role", () => {
  const LEVELS = [
    { id: "low", label: "Low", isDefault: true },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
  ];
  const PROVIDERS: GoalProviderOption[] = [
    {
      id: "claude",
      label: "Claude",
      models: [
        { id: "opus", label: "Opus", isDefault: true, thinkingOptions: LEVELS },
        { id: "haiku", label: "Haiku" },
        { id: "max", label: "Max only", thinkingOptions: [{ id: "max", label: "Max" }] },
      ],
    },
    {
      id: "codex",
      label: "Codex",
      models: [{ id: "gpt", label: "GPT", thinkingOptions: [{ id: "xhigh" }, { id: "low" }] }],
    },
  ];

  function managedForm(overrides: Parameters<typeof openGoalForm>[0] = {}) {
    const model = openGoalForm({
      thinkingSupported: true,
      ...overrides,
      prefill: {
        objective: "Ship it",
        criteriaText: "Works",
        managed: true,
        cwd: "/repo",
        leadProvider: "claude",
        defaultProvider: "codex",
        ...overrides.prefill,
      },
    });
    model.applyProviderOptions(PROVIDERS);
    return model;
  }

  it("runs the reviewer and verifier on the Lead's model unless a review provider is chosen", () => {
    const base = values({ leadProvider: "claude", leadModel: "opus" });
    expect(goalRoleModel(base, "verifier")).toEqual({ provider: "claude", model: "opus" });
    expect(
      goalRoleModel({ ...base, reviewProvider: "codex", reviewModel: "gpt" }, "verifier"),
    ).toEqual({ provider: "codex", model: "gpt" });
  });

  it("offers the levels of the chosen model, or the provider's default model", () => {
    const form = values({ leadProvider: "claude", defaultProvider: "codex" });
    expect(goalRoleThinkingOptions(form, PROVIDERS, "lead")?.map((o) => o.id)).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(goalRoleThinkingOptions({ ...form, leadModel: "haiku" }, PROVIDERS, "lead")).toEqual([]);
    expect(goalRoleThinkingOptions(form, PROVIDERS, "worker")?.map((o) => o.id)).toEqual([
      "xhigh",
      "low",
    ]);
    expect(goalRoleThinkingOptions(form, [], "lead")).toBeNull();
  });

  it("sends each level that is set, and nothing for the model's default", () => {
    const model = managedForm();
    model.setValue("leadThinking", "high");
    model.setValue("workerThinking", "xhigh");
    const config = model.getState().createInput?.config;
    expect(config).toMatchObject({ leadThinking: "high", workerThinking: "xhigh" });
    expect(config).not.toHaveProperty("reviewThinking");
    expect(config).not.toHaveProperty("verifyThinking");
  });

  it("drops a level the new model does not list and keeps one it does", () => {
    const model = managedForm();
    model.setValue("leadThinking", "medium");
    model.setValue("reviewThinking", "low");
    model.setValue("leadModel", "haiku");
    // The reviewer follows the Lead, so both lose their level on a model without any.
    expect(model.getState().values).toMatchObject({ leadThinking: "", reviewThinking: "" });
    expect(model.getState().thinkingOptions.lead).toEqual([]);

    model.setValue("workerThinking", "low");
    model.setValue("defaultProvider", "claude");
    // Claude's default model lists "low" too, so the worker keeps it.
    expect(model.getState().values.workerThinking).toBe("low");
    model.setValue("defaultModel", "max");
    expect(model.getState().values.workerThinking).toBe("");
  });

  it("keeps a remembered level until the providers say the model lacks it", () => {
    const model = openGoalForm({
      thinkingSupported: true,
      prefill: {
        objective: "Ship it",
        criteriaText: "Works",
        managed: true,
        cwd: "/repo",
        leadProvider: "claude/haiku",
        defaultProvider: "codex",
        leadThinking: "high",
        workerThinking: "xhigh",
      },
    });
    expect(model.getState().values.leadThinking).toBe("high");
    model.applyProviderOptions(PROVIDERS);
    expect(model.getState().values).toMatchObject({ leadThinking: "", workerThinking: "xhigh" });
  });

  it("neither offers nor sends thinking on a host without goalThinking", () => {
    const model = managedForm({ thinkingSupported: false, prefill: { leadThinking: "high" } });
    expect(model.getState().thinkingOptions.lead).toEqual([]);
    expect(model.getState().createInput?.config).not.toHaveProperty("leadThinking");
  });

  it("names each chosen level in the summary", () => {
    const model = managedForm();
    model.setValue("leadThinking", "high");
    model.setValue("workerThinking", "xhigh");
    expect(model.getState().summary.filter((part) => part.key === "thinking")).toEqual([
      { key: "thinking", role: "lead", label: "High" },
      { key: "thinking", role: "worker", label: expect.any(String) },
    ]);
  });

  it("leaves thinking alone when a preset is chosen", () => {
    const model = managedForm();
    model.setValue("leadThinking", "high");
    model.chooseSettings("careful");
    expect(model.getState().values.leadThinking).toBe("high");
  });

  it("remembers the levels with the last goal and offers them on the next one", () => {
    const model = managedForm();
    model.setValue("reviewThinking", "medium");
    const config = model.getState().createInput?.config;
    if (!config) {
      throw new Error("expected a managed config");
    }
    const memory = goalFormMemoryFromConfig(config, DAEMON_GOAL_SETTINGS);
    expect(memory.thinking).toEqual({ reviewer: "medium" });
    const next = openGoalForm({ serverId: "host", memoryByServer: { host: memory } });
    expect(next.getState().values.reviewThinking).toBe("medium");
  });
});
