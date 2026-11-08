import { describe, expect, it } from "vitest";
import { openGoalForm } from "./goal-form-model";
import { GOAL_PRESETS } from "./goal-settings";
import { buildFollowUpPrefill, canStartFollowUp } from "./goal-follow-up";
import { FIXTURE_AT, makeGoal, makeTask } from "./test-utils/goal-fixture";

const COPY = {
  title: (title: string) => `${title} — follow-up`,
  objectiveIntro: "Follow-up to the goal “Rate limiting”, which failed.",
  unmetIntro: "These acceptance criteria were not verified:",
};

const integration = {
  branch: "paseo-goal/goal-1",
  workspaceId: "ws-int",
  cwd: "/repo/.paseo/worktrees/goal-1",
  baseCommit: "base000",
  headCommit: "head999",
};

const failed = makeGoal({
  title: "Rate limiting",
  objective: "Limit the API",
  status: "failed",
  tasks: [makeTask("t1", { status: "succeeded" })],
  criteria: [
    { id: "c1", text: "Over the limit gets 429", verifiedAt: null, evidence: null },
    { id: "c2", text: "Docs updated", verifiedAt: FIXTURE_AT, evidence: "ok" },
  ],
  config: {
    cwd: "/repo",
    leadProvider: "claude/opus",
    defaultProvider: "codex",
    reviewProvider: "claude",
    maxParallel: 3,
    maxAttempts: 4,
    autoApprovePlan: true,
    notifyLead: false,
    testCommand: "npm test",
    allowedProviders: ["claude", "codex"],
    leadThinking: "high",
    limits: { maxRuns: 40, maxCostUsd: 20, deadlineAt: "2026-10-22T00:00:00.000Z" },
    baseCommit: "start111",
  },
  integration,
});

describe("canStartFollowUp", () => {
  it("is offered for a failed managed goal with a commit to build on", () => {
    expect(canStartFollowUp(failed)).toBe(true);
    expect(canStartFollowUp({ ...failed, integration: null })).toBe(true);
    expect(canStartFollowUp({ ...failed, status: "completed" })).toBe(false);
    expect(canStartFollowUp({ ...failed, config: null })).toBe(false);
    expect(
      canStartFollowUp({
        ...failed,
        integration: null,
        config: failed.config ? { ...failed.config, baseCommit: undefined } : null,
      }),
    ).toBe(false);
  });
});

describe("buildFollowUpPrefill", () => {
  it("builds on the failed goal's integration head with its unmet criteria and settings", () => {
    const prefill = buildFollowUpPrefill(failed, COPY);
    expect(prefill).toMatchObject({
      title: "Rate limiting — follow-up",
      criteriaText: "Over the limit gets 429",
      managed: true,
      cwd: "/repo",
      leadProvider: "claude/opus",
      defaultProvider: "codex",
      reviewProvider: "claude",
      leadThinking: "high",
      testCommand: "npm test",
      allowedProviders: ["claude", "codex"],
      baseCommit: { commit: "head999", goalTitle: "Rate limiting", branch: "paseo-goal/goal-1" },
    });
    expect(prefill?.settings).toMatchObject({
      maxParallel: 3,
      maxAttempts: 4,
      maxRuns: 40,
      autoApprovePlan: true,
      notifyLead: false,
    });
    expect(prefill?.budget).toEqual({ maxTotalTokens: null, maxCostUsd: 20 });
    // Plain text you edit: the unmet criteria, then the old objective. No Lead wording.
    expect(prefill?.objective).toBe(
      [
        COPY.objectiveIntro,
        "",
        COPY.unmetIntro,
        "- Over the limit gets 429",
        "",
        "Limit the API",
      ].join("\n"),
    );
  });

  it("asks every criterion again when all were verified, and builds on the start commit when nothing merged", () => {
    const unchecked = {
      ...failed,
      criteria: failed.criteria.map((criterion) => ({ ...criterion, verifiedAt: FIXTURE_AT })),
      integration: null,
    };
    const prefill = buildFollowUpPrefill(unchecked, COPY);
    expect(prefill?.criteriaText).toBe("Over the limit gets 429\nDocs updated");
    expect(prefill?.objective).toBe([COPY.objectiveIntro, "", "Limit the API"].join("\n"));
    expect(prefill?.baseCommit).toEqual({
      commit: "start111",
      goalTitle: "Rate limiting",
      branch: null,
    });
  });

  it("opens a form that can be sent as it is, carrying the base commit", () => {
    const prefill = buildFollowUpPrefill(failed, COPY);
    const model = openGoalForm({ serverId: "host-a", prefill: prefill ?? {} });
    const config = model.getState().createInput?.config;
    expect(config).toMatchObject({
      cwd: "/repo",
      baseCommit: "head999",
      leadProvider: "claude/opus",
      testCommand: "npm test",
    });
    // A deadline belongs to the failed goal; the follow-up does not inherit a passed one.
    expect(config?.limits?.deadlineAt).toBeUndefined();
  });

  it("keeps each criterion on one line and the follow-up suffix once", () => {
    const prefill = buildFollowUpPrefill(
      {
        ...failed,
        title: "Rate limiting — follow-up",
        criteria: [
          { id: "c1", text: "Over the limit\n  gets 429", verifiedAt: null, evidence: null },
        ],
      },
      COPY,
    );
    expect(prefill?.title).toBe("Rate limiting — follow-up");
    expect(prefill?.criteriaText).toBe("Over the limit gets 429");
    expect(prefill?.objective).toContain("- Over the limit gets 429");
  });

  it("uses the failed goal's settings over the ones remembered from your last goal", () => {
    const plain = {
      ...failed,
      config: {
        cwd: "/repo",
        leadProvider: "claude",
        defaultProvider: "codex",
        maxParallel: 2,
        maxAttempts: 2,
        autoApprovePlan: false,
        notifyLead: true,
        baseCommit: "start111",
      },
    };
    const prefill = buildFollowUpPrefill(plain, COPY);
    const model = openGoalForm({
      serverId: "host-a",
      prefill: prefill ?? {},
      memoryByServer: {
        "host-a": {
          cwd: "/repo",
          leadProvider: "opencode",
          defaultProvider: "opencode",
          reviewProvider: "opencode",
          testCommand: "make check",
          allowedProviders: ["opencode"],
          settings: GOAL_PRESETS.turbo,
          thinking: { lead: "max", worker: "max", reviewer: "max", verifier: "max" },
        },
      },
    });
    const { values } = model.getState();
    expect(values).toMatchObject({
      leadProvider: "claude",
      defaultProvider: "codex",
      reviewProvider: "",
      testCommand: "",
      allowedProviders: [],
      leadThinking: "",
      workerThinking: "",
      reviewThinking: "",
      verifyThinking: "",
    });
    expect(values.settings.maxParallel).toBe(2);
  });

  it("is null for a goal that cannot have a follow-up", () => {
    expect(buildFollowUpPrefill({ ...failed, status: "executing" }, COPY)).toBeNull();
  });
});
