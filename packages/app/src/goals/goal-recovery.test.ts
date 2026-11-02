import type { GoalDiagnosis } from "@getpaseo/protocol/goal/diagnosis";
import { MAX_RECOVERIES } from "@getpaseo/protocol/goal/interventions";
import type { Recovery } from "@getpaseo/protocol/goal/types";
import { describe, expect, it } from "vitest";
import { en } from "@/i18n/resources/en";
import { canStartFollowUp } from "./goal-follow-up";
import {
  buildRecoverRequest,
  canAddFixTasks,
  defaultRecoverTimeMode,
  diagnosisRemedyKey,
  diagnosisView,
  endedRecovery,
  goalDiagnosisView,
  goalFailureView,
  goalRecoveryControls,
  guidanceTextCut,
  isTimeLimitRefusal,
  liveRecovery,
  previousLeadReason,
  reasonPreview,
  recoverAgainView,
  recoverBlockingLimits,
  recoverNeedsTimeMode,
  summarizeReason,
  taskGuidance,
  verificationRoundView,
  unmetCriteria,
  type RecoverRules,
} from "./goal-recovery";
import { FIXTURE_AT, makeChangeSet, makeGoal, makeTask } from "./test-utils/goal-fixture";

function recovery(status: string, overrides: Partial<Recovery> = {}): Recovery {
  return {
    id: "r1",
    status,
    startedAt: FIXTURE_AT,
    startedBy: "person",
    failureReason: "Task t7 failed",
    ...overrides,
  };
}

const failed = makeGoal({
  status: "failed",
  tasks: [makeTask("t7", { title: "Capture", status: "failed" }), makeTask("t8")],
});

describe("liveRecovery", () => {
  it("is the recovery of a failed goal that has not ended", () => {
    for (const status of ["deciding", "decided", "awaiting_approval"]) {
      expect(liveRecovery({ ...failed, recovery: recovery(status) })?.status).toBe(status);
    }
    expect(liveRecovery({ ...failed, recovery: recovery("ended") })).toBeNull();
    // Applied reopens the goal; it is no longer a recovery to show.
    expect(
      liveRecovery({ ...failed, status: "executing", recovery: recovery("applied") }),
    ).toBeNull();
  });
});

describe("goalRecoveryControls", () => {
  it("offers Recover only on a failed managed goal with a plan, on a host with goalRecovery", () => {
    expect(goalRecoveryControls(failed, true).canRecover).toBe(true);
    expect(goalRecoveryControls(failed, false).canRecover).toBe(false);
    expect(goalRecoveryControls({ ...failed, config: null }, true).canRecover).toBe(false);
    expect(goalRecoveryControls({ ...failed, tasks: [] }, true).canRecover).toBe(false);
    expect(
      goalRecoveryControls({ ...failed, archivedAt: "2026-10-22T00:00:00Z" }, true).canRecover,
    ).toBe(false);
    expect(goalRecoveryControls({ ...failed, status: "executing" }, true).canRecover).toBe(false);
  });

  it("hides Recover once the goal used its recoveries or a review rejected a change", () => {
    expect(goalRecoveryControls({ ...failed, recoveries: MAX_RECOVERIES }, true).canRecover).toBe(
      false,
    );
    const rejected = makeChangeSet("cs", "t7", { status: "rejected", rejectionReason: "review" });
    expect(goalRecoveryControls({ ...failed, changeSets: [rejected] }, true).canRecover).toBe(
      false,
    );
    const mergeFailed = { ...rejected, rejectionReason: "integration_failed" };
    expect(goalRecoveryControls({ ...failed, changeSets: [mergeFailed] }, true).canRecover).toBe(
      true,
    );
    // A failed rework is reworked again only by a host with goalReworkRetry.
    const reworkFailed = { ...rejected, rejectionReason: "rework_failed" };
    const withRework = { ...failed, changeSets: [reworkFailed] };
    expect(goalRecoveryControls(withRework, true).canRecover).toBe(false);
    expect(goalRecoveryControls(withRework, true, true).canRecover).toBe(true);
    const limited = { ...rejected, rejectionReason: "rework_limit" };
    expect(goalRecoveryControls({ ...failed, changeSets: [limited] }, true, true).canRecover).toBe(
      false,
    );
  });

  it("allows no second recovery while one is live", () => {
    const deciding = goalRecoveryControls({ ...failed, recovery: recovery("deciding") }, true);
    expect(deciding).toEqual({ canRecover: false, canCancel: true, canDecide: false });
  });

  it("hides Cancel while the decision is being applied", () => {
    expect(goalRecoveryControls({ ...failed, recovery: recovery("decided") }, true)).toEqual({
      canRecover: false,
      canCancel: false,
      canDecide: false,
    });
  });

  it("offers Approve, Reject and Cancel while a plan change waits", () => {
    expect(
      goalRecoveryControls({ ...failed, recovery: recovery("awaiting_approval") }, true),
    ).toEqual({ canRecover: false, canCancel: true, canDecide: true });
  });

  it("lets an ended recovery be followed by another", () => {
    const ended = goalRecoveryControls(
      { ...failed, recovery: recovery("ended", { outcome: "needs_person" }), recoveries: 1 },
      true,
    );
    expect(ended).toEqual({ canRecover: true, canCancel: false, canDecide: false });
  });
});

describe("diagnosisView", () => {
  const diagnosis: GoalDiagnosis = {
    kind: "time",
    findings: [
      { kind: "time", remedy: "", personNeeded: "no" },
      { kind: "stuck", remedy: "", personNeeded: "depends" },
    ],
    failedAt: FIXTURE_AT,
    timePassedAtFailure: true,
    timePassedNow: true,
    failureReason: "Time limit of 60 minutes reached",
    tasks: [
      {
        taskId: "t7",
        status: "failed",
        cause: "timeout",
        lastError: "Turn timed out after 60 minutes",
        failedRuns: 3,
        countedFailures: 2,
        interruptedRuns: 1,
        blockedDependents: ["t8", "t9"],
      },
    ],
    blocked: ["t8", "t9"],
    unchanged: [],
    openChangeSets: [],
    merged: [{ changeSetId: "cs-1", taskId: "t1" }],
    runs: { used: 12, max: 60 },
    blockingLimits: [{ limit: "goalTimeoutMinutes", current: 60, used: 75, minimum: 76 }],
    recoverable: true,
  };

  it("names tasks by title and keeps what the card shows", () => {
    expect(diagnosisView(diagnosis, failed)).toEqual({
      kind: "time",
      personNeeded: "depends",
      findings: [
        { kind: "time", personNeeded: "no" },
        { kind: "stuck", personNeeded: "depends" },
      ],
      tasks: [
        {
          taskId: "t7",
          title: "Capture",
          cause: "timeout",
          failedRuns: 3,
          interruptedRuns: 1,
          blocks: ["Task t8", "t9"],
          lastError: "Turn timed out after 60 minutes",
        },
      ],
      unchanged: [],
      limits: diagnosis.blockingLimits,
      runs: { used: 12, max: 60 },
      merged: 1,
      recoverable: true,
    });
  });

  it("names the tasks that finished without changes", () => {
    expect(diagnosisView({ ...diagnosis, unchanged: ["t7"] }, failed).unchanged).toEqual([
      "Capture",
    ]);
  });

  it("needs you when any finding does, and only then", () => {
    const withYes = {
      ...diagnosis,
      findings: [
        ...diagnosis.findings,
        { kind: "budget" as const, remedy: "", personNeeded: "yes" as const },
      ],
    };
    expect(diagnosisView(withYes, failed).personNeeded).toBe("yes");
    const allNo = {
      ...diagnosis,
      findings: [{ kind: "verification" as const, remedy: "", personNeeded: "no" as const }],
    };
    expect(diagnosisView(allNo, failed).personNeeded).toBe("no");
    expect(diagnosisView({ ...diagnosis, findings: [] }, failed).personNeeded).toBe("depends");
  });

  it("has a sentence for every failure kind, cause and blocking limit", () => {
    const kinds = [
      "review_rejected",
      "planning",
      "time",
      "budget",
      "run_limit",
      "integration_failed",
      "verification",
      "stuck",
      "capture",
      "recovery_failed",
      "unknown",
    ] as const;
    for (const kind of kinds) {
      expect(en.goals.diagnosis.kind[kind]).toBeTypeOf("string");
      expect(en.goals.diagnosis.remedy[kind]).toBeTypeOf("string");
    }
    const causes = [
      "timeout",
      "pending_request",
      "worker_blocked",
      "no_answer",
      "lead_stopped",
      "canceled",
      "worker_error",
      "interrupted",
      "cancelled",
    ] as const;
    for (const cause of causes) {
      expect(en.goals.diagnosis.cause[cause]).toBeTypeOf("string");
    }
    expect(en.goals.diagnosis.causeRemedy.worker_blocked).toBeTypeOf("string");
    expect(en.goals.diagnosis.causeRemedy.no_answer).toBeTypeOf("string");
    expect(en.goals.diagnosis.unchanged).toBeTypeOf("string");
    const limits = [
      "goalTimeoutMinutes",
      "deadlineAt",
      "maxRuns",
      "maxTotalTokens",
      "maxCostUsd",
    ] as const;
    for (const limit of limits) {
      expect(en.goals.diagnosis.limits[limit]).toBeTypeOf("string");
    }
  });
});

describe("buildRecoverRequest", () => {
  const rules: RecoverRules = {
    needsTimeMode: false,
    noneLeft: false,
    current: { goal: "Use the staging API", tasks: { t7: "Skip the flaky test" } },
  };

  it("sends nothing but the request when you changed nothing", () => {
    expect(
      buildRecoverRequest(
        {
          goalText: " Use the staging API ",
          taskTexts: { t7: "Skip the flaky test" },
          timeMode: null,
        },
        rules,
      ),
    ).toEqual({ ok: true, input: {} });
  });

  it("sends new texts, and null for a text you emptied", () => {
    expect(
      buildRecoverRequest(
        { goalText: "", taskTexts: { t7: "Split the screenshots", t8: "" }, timeMode: null },
        rules,
      ),
    ).toEqual({
      ok: true,
      input: { guidance: { goal: null, tasks: { t7: "Split the screenshots" } } },
    });
  });

  it("requires a time mode once the limit passes before the recovery could apply", () => {
    const timed = { ...rules, needsTimeMode: true };
    expect(buildRecoverRequest({ goalText: "", taskTexts: {}, timeMode: null }, timed)).toEqual({
      ok: false,
      error: "timeModeRequired",
    });
    expect(
      buildRecoverRequest(
        { goalText: "Use the staging API", taskTexts: {}, timeMode: "fresh" },
        timed,
      ),
    ).toEqual({ ok: true, input: { timeMode: "fresh" } });
  });

  it("refuses remaining when it leaves no time, as the retry sheet does", () => {
    expect(
      buildRecoverRequest(
        { goalText: "Use the staging API", taskTexts: {}, timeMode: "remaining" },
        { ...rules, needsTimeMode: true, noneLeft: true },
      ),
    ).toEqual({ ok: false, error: "noneLeft" });
  });

  it("refuses a text longer than the host accepts", () => {
    expect(
      buildRecoverRequest({ goalText: "x".repeat(4001), taskTexts: {}, timeMode: null }, rules),
    ).toEqual({ ok: false, error: "tooLong", goal: true, tasks: [] });
    expect(
      buildRecoverRequest(
        { goalText: "", taskTexts: { t7: "x".repeat(4001), t8: "fine" }, timeMode: null },
        rules,
      ),
    ).toEqual({ ok: false, error: "tooLong", goal: false, tasks: ["t7"] });
  });
});

describe("taskGuidance", () => {
  it("returns your instruction and the Lead's advice for a task, or null", () => {
    const goal = makeGoal({
      guidance: {
        tasks: { t7: "Skip the flaky test" },
        lead: { recoveryId: "r1", tasks: { t7: "Run only the home screen", t8: "Reuse t7" } },
      },
    });
    expect(taskGuidance(goal, "t7")).toEqual({
      person: "Skip the flaky test",
      personCut: false,
      lead: "Run only the home screen",
    });
    expect(taskGuidance(goal, "t8")).toEqual({ person: null, personCut: false, lead: "Reuse t7" });
    expect(taskGuidance(goal, "t9")).toBeNull();
    expect(taskGuidance(makeGoal(), "t7")).toBeNull();
  });
});

describe("endedRecovery", () => {
  const ended = (overrides: Partial<Recovery> = {}) =>
    recovery("ended", {
      outcome: "needs_person",
      resolvedAt: "2026-10-21T02:00:00.000Z",
      ...overrides,
    });

  it("is the recovery whose end is the goal's current failure", () => {
    const goal = { ...failed, failedAt: "2026-10-21T02:00:00.000Z", recovery: ended() };
    expect(endedRecovery(goal)?.id).toBe("r1");
  });

  it("ignores a recovery that ended before a later failure", () => {
    // The goal was retried after the recovery ended and failed again later.
    const goal = { ...failed, failedAt: "2026-10-21T05:00:00.000Z", recovery: ended() };
    expect(endedRecovery(goal)).toBeNull();
  });

  it("ignores an applied recovery, whose goal then failed again", () => {
    const goal = {
      ...failed,
      failedAt: "2026-10-21T02:00:00.000Z",
      recovery: ended({ outcome: "applied" }),
    };
    expect(endedRecovery(goal)).toBeNull();
  });

  it("ignores a recovery without an end time, and a live goal", () => {
    expect(endedRecovery({ ...failed, recovery: ended({ resolvedAt: undefined }) })).toBeNull();
    expect(
      endedRecovery({
        ...failed,
        status: "executing",
        failedAt: "2026-10-21T02:00:00.000Z",
        recovery: ended(),
      }),
    ).toBeNull();
  });
});

describe("isTimeLimitRefusal", () => {
  it("knows both refusals the host words, and nothing else", () => {
    expect(
      isTimeLimitRefusal(
        new Error(
          "goal.retried: the goal's time limit has passed; choose time mode fresh (the full limit from now) or remaining (the limit minus the time the goal ran)",
        ),
      ),
    ).toBe(true);
    expect(
      isTimeLimitRefusal(
        new Error(
          "recovery.started: the Lead has 20 minutes to decide, and by then the goal's time limit has passed; choose time mode fresh or remaining",
        ),
      ),
    ).toBe(true);
    expect(isTimeLimitRefusal(new Error("the run limit is used up"))).toBe(false);
  });
});

describe("recoverNeedsTimeMode and recoverBlockingLimits", () => {
  const created = Date.parse(FIXTURE_AT);
  const hourGoal = {
    ...failed,
    config: { ...failed.config!, limits: { goalTimeoutMinutes: 60 } },
  };

  it("asks for a time mode when the limit passes while the Lead decides", () => {
    expect(recoverNeedsTimeMode(hourGoal, created + 30 * 60_000)).toBe(false);
    // 50 minutes in: the 20 minutes the Lead has run past the hour.
    expect(recoverNeedsTimeMode(hourGoal, created + 50 * 60_000)).toBe(true);
    expect(recoverNeedsTimeMode(hourGoal, created + 90 * 60_000)).toBe(true);
  });

  it("lists a deadline that passes while the Lead decides, and leaves the time limit to the choice", () => {
    const deadline = new Date(created + 60 * 60_000).toISOString();
    const goal = {
      ...hourGoal,
      config: { ...hourGoal.config, limits: { goalTimeoutMinutes: 60, deadlineAt: deadline } },
    };
    const limits = recoverBlockingLimits(goal, [], created + 50 * 60_000);
    expect(limits.map((limit) => limit.limit)).toEqual(["deadlineAt"]);
    expect(recoverBlockingLimits(goal, [], created + 10 * 60_000)).toEqual([]);
  });
});

describe("goalDiagnosisView", () => {
  it("reads a live recovery's time mode as settling the passed time limit", () => {
    const created = Date.parse(FIXTURE_AT);
    const goal = {
      ...failed,
      config: { ...failed.config!, limits: { goalTimeoutMinutes: 60 } },
      failedAt: new Date(created + 61 * 60_000).toISOString(),
    };
    const now = created + 120 * 60_000;
    const without = goalDiagnosisView(goal, [], now);
    expect(without.findings[0]).toEqual({ kind: "time", personNeeded: "yes" });
    expect(without.limits.map((limit) => limit.limit)).toEqual(["goalTimeoutMinutes"]);
    const recovering = goalDiagnosisView(
      { ...goal, recovery: recovery("deciding", { timeMode: "fresh" }) },
      [],
      now,
    );
    expect(recovering.findings[0]).toEqual({ kind: "time", personNeeded: "no" });
    expect(recovering.limits).toEqual([]);
  });
});

describe("guidanceTextCut", () => {
  it("marks only a text a list payload cut short", () => {
    const cut = `${"x".repeat(499)}…`;
    expect(guidanceTextCut(makeGoal({ guidance: { goal: cut, truncated: true } }), cut)).toBe(true);
    expect(
      guidanceTextCut(makeGoal({ guidance: { goal: "short", truncated: true } }), "short"),
    ).toBe(false);
    expect(guidanceTextCut(makeGoal({ guidance: { goal: cut } }), cut)).toBe(false);
  });
});

describe("summarizeReason", () => {
  it("keeps a path with dots and line numbers whole", () => {
    expect(summarizeReason("Fails in updater_module.c:1301-1310 when v1.2.3 is set")).toBe(
      "Fails in updater_module.c:1301-1310 when v1.2.3 is set",
    );
    expect(summarizeReason("See src/a.b/c.test.ts.")).toBe("See src/a.b/c.test.ts.");
  });

  it("ends at the first sentence or the first line", () => {
    expect(summarizeReason("UV-02 is not met. The fix needs a schema change.")).toBe(
      "UV-02 is not met.",
    );
    expect(summarizeReason("\n  First line\nSecond line. More")).toBe("First line");
    expect(summarizeReason("Line one\r\nLine two")).toBe("Line one");
  });

  it("cuts a long sentence at the limit with an ellipsis", () => {
    const long = "a".repeat(200);
    const summary = summarizeReason(long);
    expect(summary).toHaveLength(160);
    expect(summary.endsWith("…")).toBe(true);
    expect(summarizeReason("abcdef", 4)).toBe("abc…");
    expect(summarizeReason("")).toBe("");
  });
});

describe("reasonPreview", () => {
  it("expands only when there is more than the collapsed line shows", () => {
    expect(reasonPreview("Short reason").canExpand).toBe(false);
    expect(reasonPreview("First. Second").canExpand).toBe(true);
    expect(reasonPreview("x".repeat(100)).canExpand).toBe(true);
    expect(reasonPreview("  padded  ")).toEqual({
      full: "padded",
      summary: "padded",
      canExpand: false,
    });
  });
});

describe("unmetCriteria", () => {
  it("lists the criteria no verifier confirmed", () => {
    const goal = makeGoal({
      criteria: [
        { id: "c1", text: "Fast", verifiedAt: null, evidence: null },
        { id: "c2", text: "Correct", verifiedAt: FIXTURE_AT, evidence: "ok" },
      ],
    });
    expect(unmetCriteria(goal).map((criterion) => criterion.id)).toEqual(["c1"]);
  });
});

describe("goalFailureView", () => {
  const at = "2026-10-21T02:00:00.000Z";
  const criteria = [
    { id: "c1", text: "UV-02 passes", verifiedAt: null, evidence: null },
    { id: "c2", text: "Build is green", verifiedAt: FIXTURE_AT, evidence: "ok" },
  ];
  const leadReason =
    "UV-02 still fails in updater_module.c:1301-1310. A person must decide the schema.";
  const needsPerson = {
    ...failed,
    criteria,
    failedAt: at,
    failureReason: `Recovery needs a person: ${leadReason}`,
    recoveries: 1,
    recovery: recovery("ended", {
      outcome: "needs_person",
      resolvedAt: at,
      reason: leadReason,
      failureReason: "Acceptance criteria not met: c1",
      decision: { decision: "needs_person", reason: leadReason },
    }),
  };

  it("says a recovery that needs you once: the Lead's first sentence, the rest under details", () => {
    const view = goalFailureView(needsPerson);
    expect(view).toEqual({
      recoveryNeedsYou: true,
      summary: "UV-02 still fails in updater_module.c:1301-1310.",
      fullReason: leadReason,
      fullReasonIsLead: true,
      originalFailure: "Acceptance criteria not met: c1",
      unmet: [criteria[0]],
      hasDetails: true,
    });
    // The prefix the host adds is not repeated in the summary.
    expect(view?.summary).not.toContain("Recovery needs a person");
  });

  it("shows a plain failure's reason without Lead wording or an original failure", () => {
    const view = goalFailureView({ ...failed, failureReason: "Task t7 failed" });
    expect(view).toMatchObject({
      recoveryNeedsYou: false,
      summary: "Task t7 failed",
      fullReason: null,
      fullReasonIsLead: false,
      originalFailure: null,
      hasDetails: false,
    });
  });

  it("leaves out the unmet criteria of a goal that failed before it had a plan", () => {
    const view = goalFailureView({ ...failed, tasks: [], criteria, failureReason: "No plan" });
    expect(view?.unmet).toEqual([]);
  });

  it("ignores a recovery that ended before a later failure", () => {
    const view = goalFailureView({
      ...needsPerson,
      failedAt: "2026-10-22T00:00:00.000Z",
      failureReason: "Task t7 failed",
    });
    expect(view).toMatchObject({ recoveryNeedsYou: false, summary: "Task t7 failed" });
    expect(view?.originalFailure).toBeNull();
  });

  it("is null for a goal that has not failed", () => {
    expect(goalFailureView({ ...failed, status: "executing" })).toBeNull();
  });

  it("gives the Recover sheet the Lead's reason as context, never anything else", () => {
    expect(previousLeadReason(needsPerson)).toBe(leadReason);
    expect(previousLeadReason({ ...failed, failureReason: "Task t7 failed" })).toBeNull();
  });
});

describe("recoverAgainView", () => {
  it("offers Recover, then Recover again with the recoveries left", () => {
    expect(recoverAgainView(failed, true)).toEqual({
      kind: "available",
      again: false,
      left: MAX_RECOVERIES,
      max: MAX_RECOVERIES,
    });
    expect(recoverAgainView({ ...failed, recoveries: 2 }, true)).toEqual({
      kind: "available",
      again: true,
      left: 1,
      max: MAX_RECOVERIES,
    });
  });

  it("says again after a recovery that ended without counting", () => {
    const cancelled = recovery("ended", { outcome: "cancelled", resolvedAt: FIXTURE_AT });
    expect(recoverAgainView({ ...failed, recovery: cancelled }, true)).toMatchObject({
      kind: "available",
      again: true,
      left: MAX_RECOVERIES,
    });
  });

  it("is disabled, not hidden, once every recovery is used", () => {
    expect(recoverAgainView({ ...failed, recoveries: MAX_RECOVERIES }, true)).toEqual({
      kind: "exhausted",
      used: MAX_RECOVERIES,
      max: MAX_RECOVERIES,
    });
  });

  it("hides when the goal could not recover anyway", () => {
    expect(recoverAgainView(failed, false).kind).toBe("hidden");
    expect(recoverAgainView({ ...failed, recoveries: MAX_RECOVERIES, tasks: [] }, true).kind).toBe(
      "hidden",
    );
    expect(
      recoverAgainView({ ...failed, archivedAt: FIXTURE_AT, recoveries: MAX_RECOVERIES }, true)
        .kind,
    ).toBe("hidden");
    expect(recoverAgainView({ ...failed, status: "completed" }, true).kind).toBe("hidden");
  });
});

describe("defaultRecoverTimeMode", () => {
  it("keeps the time left when it is at least 30 minutes, else starts fresh", () => {
    expect(defaultRecoverTimeMode(30 * 60_000)).toBe("remaining");
    expect(defaultRecoverTimeMode(2 * 60 * 60_000)).toBe("remaining");
    expect(defaultRecoverTimeMode(30 * 60_000 - 1)).toBe("fresh");
    expect(defaultRecoverTimeMode(0)).toBe("fresh");
    expect(defaultRecoverTimeMode(null)).toBe("fresh");
  });
});

describe("failure copy", () => {
  it("has every sentence the failure banner and the Recover sheet use", () => {
    const failure = en.goals.failure;
    for (const key of [
      "needsYouTitle",
      "showDetails",
      "hideDetails",
      "leadSaid",
      "originalFailure",
      "unmetCriteria",
      "recoverAgain",
      "recoveriesLeft",
      "noRecoveriesLeft",
      "noRecoveriesLeftFollowUp",
      "followUp",
      "followUpTitle",
      "followUpObjective",
      "followUpUnmet",
    ] as const) {
      expect(failure[key]).toBeTruthy();
    }
  });
});

describe("a failed verification", () => {
  const created = Date.parse(FIXTURE_AT);
  const unverified = makeGoal({
    status: "failed",
    failedAt: new Date(created + 30 * 60_000).toISOString(),
    failureReason: "Acceptance criteria not met: - UV-02 is fixed (open FAIL)",
    tasks: [makeTask("t1", { status: "succeeded" }), makeTask("t6", { status: "succeeded" })],
    criteria: [
      { id: "c1", text: "UV-02 is fixed", verifiedAt: null, evidence: null },
      { id: "c2", text: "Tests pass", verifiedAt: FIXTURE_AT, evidence: "green" },
    ],
    integration: {
      branch: "paseo-goal/goal-1",
      workspaceId: "ws-int",
      cwd: "/repo/.paseo/worktrees/goal-1",
      baseCommit: "base000",
      headCommit: "head999",
    },
  });
  const now = created + 40 * 60_000;
  const finding = (recoveries: number) =>
    goalDiagnosisView({ ...unverified, recoveries }, [], now).findings.find(
      (candidate) => candidate.kind === "verification",
    )!;

  it("lets the Lead add fix tasks on a host that verifies every criterion again", () => {
    expect(diagnosisRemedyKey(finding(0), { recoveries: 0 }, true)).toBe(
      "goals.diagnosis.remedy.verification",
    );
    expect(diagnosisRemedyKey(finding(2), { recoveries: 2 }, true)).toBe(
      "goals.diagnosis.remedy.verification_last",
    );
  });

  it("keeps the old wording on an older host, where the plan can only lose tasks", () => {
    expect(diagnosisRemedyKey(finding(0), { recoveries: 0 }, false)).toBe(
      "goals.diagnosis.remedy.verification_legacy",
    );
    expect(en.goals.diagnosis.remedy.verification_legacy).toContain("only lose tasks");
    expect(en.goals.diagnosis.remedy.verification).not.toContain("only lose tasks");
  });

  it("with no recovery left, needs you: Recover is disabled and the follow-up goal is offered", () => {
    const spent = { ...unverified, recoveries: MAX_RECOVERIES };
    expect(finding(MAX_RECOVERIES).personNeeded).toBe("yes");
    expect(goalDiagnosisView(spent, [], now).personNeeded).toBe("yes");
    for (const host of [true, false]) {
      expect(diagnosisRemedyKey(finding(MAX_RECOVERIES), spent, host)).toBe(
        "goals.diagnosis.remedy.verification_none_left",
      );
    }
    expect(recoverAgainView(spent, true).kind).toBe("exhausted");
    expect(canStartFollowUp(spent)).toBe(true);
  });

  it("words other findings by their kind", () => {
    expect(diagnosisRemedyKey({ kind: "stuck", personNeeded: "depends" }, unverified, true)).toBe(
      "goals.diagnosis.remedy.stuck",
    );
  });

  it("has a sentence for each wording", () => {
    const remedy: Record<string, string> = en.goals.diagnosis.remedy;
    for (const key of [
      "verification",
      "verification_last",
      "verification_none_left",
      "verification_legacy",
    ]) {
      expect(remedy[key], key).toBeTypeOf("string");
    }
  });

  it("offers fix tasks only when every task succeeded and a criterion is not verified", () => {
    expect(canAddFixTasks(unverified)).toBe(true);
    expect(canAddFixTasks({ ...unverified, status: "executing" })).toBe(false);
    expect(
      canAddFixTasks({
        ...unverified,
        tasks: [makeTask("t1", { status: "succeeded" }), makeTask("t6", { status: "failed" })],
      }),
    ).toBe(false);
    expect(
      canAddFixTasks({
        ...unverified,
        criteria: unverified.criteria.map((c) => ({ ...c, verifiedAt: FIXTURE_AT })),
      }),
    ).toBe(false);
    expect(canAddFixTasks({ ...unverified, tasks: [] })).toBe(false);
  });
});

describe("verificationRoundView", () => {
  it("is absent in round 0", () => {
    expect(verificationRoundView({})).toBeNull();
  });

  it("waits for the fix tasks, then checks every criterion again", () => {
    expect(verificationRoundView({ verificationRound: 1 })).toEqual({ round: 1, started: false });
    expect(verificationRoundView({ verificationRound: 2, verifyStartedAt: FIXTURE_AT })).toEqual({
      round: 2,
      started: true,
    });
    expect(en.goals.detail.verificationRoundPending).toContain("{{round}}");
    expect(en.goals.detail.verificationRoundStarted).toContain("{{round}}");
  });
});
