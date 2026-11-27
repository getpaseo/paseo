import type { GoalEvent } from "@getpaseo/protocol/goal/types";
import { describe, expect, it } from "vitest";
import { en } from "@/i18n/resources/en";
import { buildGoalEventFeed, describeGoalEvent, verifiedRound } from "./goal-event-feed";
import { reasonPreview } from "./goal-recovery";
import { FIXTURE_AT, makeChangeSet, makeGoal, makeRun, makeTask } from "./test-utils/goal-fixture";

const goal = makeGoal({
  tasks: [makeTask("t1", { title: "Add tests" }), makeTask("t2", { title: "Fix bug" })],
  runs: [makeRun("r1", "t1")],
  changeSets: [makeChangeSet("c1", "t2")],
  criteria: [{ id: "k1", text: "Tests pass", verifiedAt: null, evidence: null }],
});

let seq = 0;
function event(body: Record<string, unknown>): GoalEvent {
  seq += 1;
  return { id: `e${seq}`, goalId: "goal-1", seq, at: FIXTURE_AT, ...body } as GoalEvent;
}

describe("describeGoalEvent", () => {
  it("names tasks, change sets and criteria by their titles", () => {
    expect(
      describeGoalEvent(event({ type: "task.failed", taskId: "t1", error: "boom" }), goal),
    ).toEqual({ key: "taskFailed", tone: "error", subject: "Add tests", detail: "boom" });
    expect(
      describeGoalEvent(
        event({ type: "changeset.transitioned", changeSetId: "c1", to: "awaiting_human" }),
        goal,
      ),
    ).toMatchObject({ key: "changeSetAwaitingYou", tone: "warning", subject: "Fix bug" });
    expect(
      describeGoalEvent(event({ type: "criterion.verified", criterionId: "k1" }), goal),
    ).toMatchObject({ key: "criterionVerified", subject: "Tests pass" });
    expect(
      describeGoalEvent(event({ type: "run.finished", runId: "r1", outcome: "interrupted" }), goal),
    ).toMatchObject({ key: "runInterrupted", subject: "Add tests" });
  });

  it("tells a dismissed goal", () => {
    expect(describeGoalEvent(event({ type: "goal.acknowledged" }), goal)).toEqual({
      key: "goalAcknowledged",
      tone: "default",
      subject: null,
    });
  });

  it("tells a settings change and a planning failure reopened", () => {
    expect(
      describeGoalEvent(event({ type: "goal.config_updated", config: goal.config }), goal),
    ).toMatchObject({ key: "goalConfigUpdated", tone: "default" });
    expect(describeGoalEvent(event({ type: "goal.reopened" }), goal)).toMatchObject({
      key: "goalReopened",
      tone: "default",
    });
  });

  it("tells a failed merge retried, naming the change", () => {
    expect(
      describeGoalEvent(
        event({ type: "changeset.integration_retried", changeSetIds: ["c1"], taskIds: [] }),
        goal,
      ),
    ).toEqual({ key: "integrationRetried", tone: "default", subject: "Fix bug" });
  });

  it("falls back to the id for something it cannot find", () => {
    expect(describeGoalEvent(event({ type: "task.retried", taskId: "gone" }), goal)).toMatchObject({
      subject: "gone",
    });
  });

  it("hides bookkeeping", () => {
    const hidden = [
      event({ type: "run.attached", runId: "r1", agentId: "a", workspaceId: "w" }),
      event({ type: "task.started", taskId: "t1" }),
      event({ type: "run.finished", runId: "r1", outcome: "succeeded" }),
      event({ type: "lead.notified", key: "k" }),
      event({ type: "notification.queued", key: "k", target: "lead", text: "x" }),
      event({
        type: "notification.attempted",
        key: "k",
        target: "lead",
        attempt: 1,
        outcome: "delivered",
      }),
      event({ type: "usage.recorded", role: "worker", agentId: "a" }),
      event({ type: "changeset.transitioned", changeSetId: "c1", to: "superseded" }),
    ];
    for (const entry of hidden) {
      expect(describeGoalEvent(entry, goal)).toBeNull();
    }
  });

  it("names the reason for a rework task and the target of a failed notification", () => {
    expect(
      describeGoalEvent(
        event({
          type: "task.added",
          task: { id: "t2-rw1", title: "Fix", description: "", kind: "implement", dependsOn: [] },
          rework: { changeSetId: "c1", reason: "tests", round: 1 },
        }),
        goal,
      ),
    ).toMatchObject({ key: "reworkAdded_tests", subject: "Fix bug" });
    expect(
      describeGoalEvent(
        event({
          type: "notification.attempted",
          key: "k",
          target: "origin",
          attempt: 1,
          outcome: "failed",
          error: "offline",
        }),
        goal,
      ),
    ).toMatchObject({ key: "notifyFailed_origin", detail: "offline" });
  });
});

describe("the Lead's decisions, check-ins, plan changes and recoveries", () => {
  const leadGoal = makeGoal({
    tasks: [makeTask("t7", { title: "Capture screenshots" })],
    interventions: [
      {
        id: "t7-a2",
        taskId: "t7",
        runId: "t7-a2",
        trigger: "timeout",
        error: "Turn timed out after 90 minutes",
        status: "resolved",
        requestedAt: FIXTURE_AT,
      },
      {
        id: "t7-a3:check-1",
        taskId: "t7",
        runId: "t7-a3",
        trigger: "watch",
        triggers: ["near_timeout"],
        checkIn: 1,
        error: "",
        status: "resolved",
        requestedAt: FIXTURE_AT,
      },
      {
        id: "recovery-r1",
        trigger: "recovery",
        error: "",
        status: "resolved",
        requestedAt: FIXTURE_AT,
      },
    ],
  });
  const describeLead = (body: Record<string, unknown>) => describeGoalEvent(event(body), leadGoal);

  it("tells the Lead is deciding about a failed task, with why", () => {
    expect(
      describeLead({
        type: "intervention.requested",
        interventionId: "t7-a2",
        taskId: "t7",
        runId: "t7-a2",
        trigger: "timeout",
        error: "Turn timed out after 90 minutes",
      }),
    ).toEqual({ key: "leadDeciding_timeout", tone: "warning", subject: "Capture screenshots" });
    expect(
      describeLead({
        type: "intervention.requested",
        interventionId: "t7-a1",
        taskId: "t7",
        runId: "t7-a1",
        trigger: "worker_blocked",
        error: "Worker reported it was blocked: disk full",
      }),
    ).toEqual({
      key: "leadDeciding_worker_blocked",
      tone: "warning",
      subject: "Capture screenshots",
    });
    expect(
      describeLead({
        type: "intervention.requested",
        interventionId: "x",
        taskId: "t7",
        trigger: "something_new",
        error: "",
      }),
    ).toMatchObject({ key: "leadDeciding" });
  });

  it("tells the Lead's decision with its reason", () => {
    expect(
      describeLead({
        type: "intervention.resolved",
        interventionId: "t7-a2",
        outcome: "continue",
        note: "Flaky network",
      }),
    ).toEqual({
      key: "leadDecided_continue",
      tone: "default",
      subject: "Capture screenshots",
      detail: "Flaky network",
    });
    expect(
      describeLead({ type: "intervention.resolved", interventionId: "t7-a2", outcome: "give_up" }),
    ).toMatchObject({ key: "leadDecided_give_up", tone: "error" });
    expect(
      describeLead({ type: "intervention.resolved", interventionId: "t7-a2", outcome: "expired" }),
    ).toMatchObject({ key: "leadDecided_expired", tone: "warning" });
  });

  it("tells a check-in, its trigger and how it ended, with the nudge's first line", () => {
    expect(
      describeLead({
        type: "intervention.requested",
        interventionId: "t7-a3:check-1",
        taskId: "t7",
        runId: "t7-a3",
        trigger: "watch",
        triggers: ["stall", "near_timeout"],
        checkIn: 1,
        error: "",
      }),
    ).toEqual({
      key: "checkInRequested_near_timeout",
      tone: "default",
      subject: "Capture screenshots",
    });
    expect(
      describeLead({
        type: "intervention.resolved",
        interventionId: "t7-a3:check-1",
        outcome: "nudged",
        message: "\nFocus on the home screen.\nSkip settings.",
      }),
    ).toMatchObject({ key: "checkIn_nudged", detail: "Focus on the home screen." });
    expect(
      describeLead({
        type: "intervention.resolved",
        interventionId: "t7-a3:check-1",
        outcome: "stopped",
        note: "Will not finish in time",
      }),
    ).toMatchObject({ key: "checkIn_stopped", tone: "warning", detail: "Will not finish in time" });
  });

  it("leaves a recovery's decision to the recovery events, and words an unknown one plainly", () => {
    expect(
      describeLead({
        type: "intervention.requested",
        interventionId: "recovery-r1",
        trigger: "recovery",
        error: "",
      }),
    ).toBeNull();
    expect(
      describeLead({
        type: "intervention.resolved",
        interventionId: "recovery-r1",
        outcome: "expired",
      }),
    ).toBeNull();
    expect(
      describeLead({
        type: "intervention.resolved",
        interventionId: "gone",
        outcome: "ok",
        note: "n",
      }),
    ).toEqual({ key: "leadAnswered", tone: "default", subject: null, detail: "n" });
  });

  it("tells plan changes by who proposed them, naming the tasks", () => {
    expect(
      describeLead({
        type: "plan.revision_proposed",
        revisionId: "rev-1",
        source: "lead",
        reason: "Split the screenshots",
        ops: [
          { op: "remove", taskId: "t7" },
          {
            op: "add",
            task: {
              id: "t7b",
              title: "Home screen",
              description: "",
              kind: "implement",
              dependsOn: [],
            },
          },
        ],
      }),
    ).toEqual({
      key: "revisionProposed_lead",
      tone: "default",
      subject: "Capture screenshots, Home screen",
      detail: "Split the screenshots",
    });
    expect(
      describeLead({ type: "plan.revision_rejected", revisionId: "rev-1", reason: "No" }),
    ).toMatchObject({ key: "revisionRejected", tone: "warning", detail: "No" });
  });

  it("tells a recovery from start to end", () => {
    expect(
      describeLead({ type: "recovery.started", recoveryId: "r1", startedBy: "person" }),
    ).toMatchObject({ key: "recoveryStarted" });
    expect(
      describeLead({
        type: "recovery.decided",
        recoveryId: "r1",
        decision: { decision: "needs_person", reason: "Raise maxRuns to 80" },
      }),
    ).toEqual({
      key: "recoveryDecided_needs_person",
      tone: "warning",
      subject: null,
      detail: "Raise maxRuns to 80",
    });
    expect(
      describeLead({
        type: "recovery.decided",
        recoveryId: "r1",
        decision: { decision: "retry", reason: "", fallback: true },
      }),
    ).toMatchObject({ key: "recoveryDecided_fallback", detail: null });
    expect(
      describeLead({ type: "recovery.resolved", recoveryId: "r1", outcome: "applied" }),
    ).toMatchObject({ key: "recoveryResolved_applied", tone: "success" });
  });

  it("has an English sentence for every line it can produce", () => {
    const keys = [
      "revisionProposed_lead",
      "revisionProposed_person",
      "revisionApproved",
      "revisionRejected",
      "leadDeciding",
      "leadAnswered",
      "checkInRequested",
      "checkInRequested_near_timeout",
      "checkInRequested_stall",
      "recoveryStarted",
      ...[
        "timeout",
        "repeated_failure",
        "attempts_exhausted",
        "worker_blocked",
        "lead_stopped",
      ].map((trigger) => `leadDeciding_${trigger}`),
      ...["continue", "give_up", "expired", "lead_unavailable", "unknown"].map(
        (outcome) => `leadDecided_${outcome}`,
      ),
      ...["ok", "nudged", "stopped", "expired", "lead_unavailable", "unknown"].map(
        (outcome) => `checkIn_${outcome}`,
      ),
      ...["retry", "revise", "needs_person", "fallback", "unknown"].map(
        (decision) => `recoveryDecided_${decision}`,
      ),
      ...["applied", "rejected", "needs_person", "cancelled", "unknown"].map(
        (outcome) => `recoveryResolved_${outcome}`,
      ),
    ];
    const events: Record<string, string> = en.goals.events;
    for (const key of keys) {
      expect(events[key], key).toBeTypeOf("string");
    }
  });
});

describe("buildGoalEventFeed", () => {
  it("lists newest first and folds repeats into one line", () => {
    const feed = buildGoalEventFeed(
      [
        event({ type: "goal.created", title: "G", objective: "", criteria: [] }),
        event({ type: "run.started", runId: "r1", taskId: "t1", provider: "codex" }),
        event({ type: "task.started", taskId: "t1" }),
        event({ type: "run.started", runId: "r2", taskId: "t2", provider: "codex" }),
        event({ type: "task.succeeded", taskId: "t1" }),
      ],
      goal,
    );
    expect(feed.map((entry) => [entry.key, entry.subjects, entry.count])).toEqual([
      ["taskSucceeded", ["Add tests"], 1],
      ["taskStarted", ["Add tests", "Fix bug"], 2],
      ["goalCreated", [], 1],
    ]);
  });

  it("keeps lines with different details apart", () => {
    const feed = buildGoalEventFeed(
      [
        event({ type: "task.failed", taskId: "t1", error: "a" }),
        event({ type: "task.failed", taskId: "t1", error: "b" }),
      ],
      goal,
    );
    expect(feed).toHaveLength(2);
  });
});

describe("verification rounds", () => {
  const roundGoal = makeGoal({
    criteria: [
      { id: "c2", text: "UV-02 is fixed", verifiedAt: null, evidence: null },
      { id: "c3", text: "Tests pass", verifiedAt: null, evidence: null },
    ],
  });
  const verified = (criterionId: string, suffix = "") =>
    event({
      type: "criterion.verified",
      criterionId,
      id: `goal-1:verified:${criterionId}${suffix}`,
    });

  it("reads the round from the event id: round 0 has no suffix", () => {
    const roundOf = (suffix: string) =>
      verifiedRound(verified("c2", suffix) as Extract<GoalEvent, { type: "criterion.verified" }>);
    expect(roundOf("")).toBe(0);
    expect(roundOf(":v1")).toBe(1);
    expect(roundOf(":v12")).toBe(12);
    expect(roundOf(":vx")).toBe(0);
  });

  it("keeps both lines for a criterion verified in two rounds, naming the later round", () => {
    const feed = buildGoalEventFeed(
      [
        verified("c2"),
        verified("c3"),
        event({ type: "goal.failed", reason: "Acceptance criteria not met" }),
        event({ type: "recovery.resolved", recoveryId: "r1", outcome: "applied" }),
        verified("c2", ":v1"),
        verified("c3", ":v1"),
      ],
      roundGoal,
    );
    const lines = feed.filter((entry) => entry.key.startsWith("criterionVerified"));
    expect(lines.map((entry) => [entry.key, entry.round, entry.subjects, entry.count])).toEqual([
      ["criterionVerifiedRound", 1, ["UV-02 is fixed", "Tests pass"], 2],
      ["criterionVerified", null, ["UV-02 is fixed", "Tests pass"], 2],
    ]);
    // Every line keeps its own id, so a list keyed on it never collides across rounds.
    expect(new Set(feed.map((entry) => entry.id)).size).toBe(feed.length);
  });

  it("does not fold two rounds of the same criterion into one line", () => {
    const feed = buildGoalEventFeed(
      [verified("c2", ":v1"), verified("c2", ":v2"), verified("c2")],
      roundGoal,
    );
    expect(feed.map((entry) => [entry.key, entry.round, entry.count])).toEqual([
      ["criterionVerified", null, 1],
      ["criterionVerifiedRound", 2, 1],
      ["criterionVerifiedRound", 1, 1],
    ]);
  });

  it("has a sentence for a later round", () => {
    expect(en.goals.events.criterionVerifiedRound).toContain("{{round}}");
  });
});

describe("one-line details", () => {
  it("keeps a recovery's full reason on the entry, shown as its first sentence until opened", () => {
    const reason = "UV-02 fails in updater_module.c:1301-1310. A person must choose the schema.";
    const [entry] = buildGoalEventFeed(
      [
        event({
          type: "recovery.decided",
          recoveryId: "r1",
          decision: { decision: "needs_person", reason },
        }),
      ],
      goal,
    );
    expect(entry?.detail).toBe(reason);
    expect(reasonPreview(entry?.detail ?? "")).toEqual({
      full: reason,
      summary: "UV-02 fails in updater_module.c:1301-1310.",
      canExpand: true,
    });
  });

  it("tells a goal you accepted as is, with how many it waived and your note", () => {
    const note = "Good enough for the release. UV-02 moves to the next goal.";
    const [entry] = buildGoalEventFeed(
      [
        event({
          type: "goal.accepted",
          criterionIds: ["k1", "k2"],
          note,
          acceptedFrom: "Acceptance criteria not met: k1, k2",
          client: "app",
        }),
      ],
      goal,
    );
    expect(entry).toMatchObject({
      key: "goalAccepted",
      tone: "success",
      subjects: ["2"],
      detail: note,
    });
    expect(en.goals.events.goalAccepted).toContain("{{subject}}");
    expect(reasonPreview(entry?.detail ?? "").summary).toBe("Good enough for the release.");
  });

  it("has the hint the expandable lines read out", () => {
    expect(en.goals.events.expandHint).toBeTruthy();
  });
});
