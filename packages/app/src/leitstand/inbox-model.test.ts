import type { ScheduleSummary } from "@getpaseo/protocol/schedule/types";
import { describe, expect, it } from "vitest";
import {
  availableSnoozeOptions,
  buildLeitstandInbox,
  deriveLeitstandMood,
  snoozeUntil,
  WAITING_INBOX_WINDOW_MS,
  type InboxItem,
} from "./inbox-model";
import type {
  LeitstandAgent,
  LeitstandPullRequest,
  LeitstandSchedule,
  LeitstandSession,
} from "./session-model";

const NOW = new Date(2026, 8, 30, 14, 10, 0).getTime();

function agent(overrides: Partial<LeitstandAgent> = {}): LeitstandAgent {
  return {
    id: "agent-1",
    title: "Dev",
    provider: "claude",
    model: "sonnet",
    bucket: "running",
    pendingPermission: null,
    lastError: null,
    lastActivityAt: new Date(NOW - 60_000),
    personFacing: true,
    ...overrides,
  };
}

function pr(overrides: Partial<LeitstandPullRequest> = {}): LeitstandPullRequest {
  return {
    number: 1,
    url: "https://github.com/acme/app/pull/1",
    title: "Change",
    state: "open",
    isDraft: false,
    checksStatus: "pending",
    ...overrides,
  };
}

function session(overrides: Partial<LeitstandSession> = {}): LeitstandSession {
  return {
    topic: null,
    key: "srv:ws-1",
    serverId: "srv",
    workspaceId: "ws-1",
    projectViewKey: "project-a",
    projectName: "app",
    projectRootPath: "/repo/app",
    name: "Riesling",
    branch: "feature/riesling",
    context: "feature/riesling",
    bucket: "running",
    since: new Date(NOW - 60_000),
    agents: [agent()],
    pullRequests: [],
    attachedPullRequests: [],
    jiraKeys: [],
    doneAt: null,
    handedBackAt: new Date(NOW - 60_000),
    handoff: null,
    ...overrides,
  };
}

function schedule(overrides: Partial<ScheduleSummary> = {}): LeitstandSchedule {
  const summary: ScheduleSummary = {
    id: "sched-1",
    name: "Daily",
    prompt: "Prepare the daily",
    cadence: { type: "cron", expression: "0 8 * * 1-5" },
    target: { type: "new-agent", config: { provider: "claude", cwd: "/repo/app" } },
    status: "active",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    nextRunAt: "2026-10-01T06:00:00.000Z",
    lastRunAt: "2026-09-30T06:00:00.000Z",
    pausedAt: null,
    expiresAt: null,
    maxRuns: null,
    lastRun: null,
    ...overrides,
  };
  return {
    key: `srv:${summary.id}`,
    serverId: "srv",
    schedule: summary,
    projectViewKey: "project-a",
    projectName: "app",
  };
}

function inbox(input: {
  sessions?: LeitstandSession[];
  schedules?: LeitstandSchedule[];
  snoozedUntil?: Record<string, number>;
  nowMs?: number;
}) {
  return buildLeitstandInbox({
    sessions: input.sessions ?? [],
    schedules: input.schedules ?? [],
    snoozedUntil: input.snoozedUntil ?? {},
    nowMs: input.nowMs ?? NOW,
  });
}

function kinds(items: readonly InboxItem[]) {
  return items.map((item) => item.kind);
}

describe("buildLeitstandInbox", () => {
  it("asks for a permission when an agent of a waiting session holds one", () => {
    const { items } = inbox({
      sessions: [
        session({
          bucket: "needs_input",
          agents: [
            agent({
              id: "a-2",
              bucket: "needs_input",
              pendingPermission: { id: "perm-7", title: "Run npm test" },
            }),
          ],
        }),
      ],
    });
    expect(items).toEqual([
      expect.objectContaining({
        kind: "permission",
        id: "srv:ws-1|permission|perm-7",
        agentId: "a-2",
        agentLabel: "Dev",
        request: "Run npm test",
      }),
    ]);
  });

  it("reads a waiting session without a permission as an open question", () => {
    const { items } = inbox({ sessions: [session({ bucket: "needs_input" })] });
    expect(kinds(items)).toEqual(["question"]);
  });

  it("reports the failing agent and its error", () => {
    const { items } = inbox({
      sessions: [
        session({
          bucket: "failed",
          agents: [agent({ id: "a-9", bucket: "failed", lastError: "Token expired" })],
        }),
      ],
    });
    expect(items[0]).toMatchObject({ kind: "agent_error", agentId: "a-9", error: "Token expired" });
  });

  it("reports a schedule whose last run failed, and nothing for a good run", () => {
    const run = {
      id: "run-3",
      scheduledFor: "2026-09-30T06:00:00.000Z",
      startedAt: "2026-09-30T06:00:00.000Z",
      endedAt: "2026-09-30T06:01:00.000Z",
      status: "failed" as const,
      agentId: null,
      workspaceId: "ws-9",
      error: "Slack token expired",
    };
    const failed = schedule({ lastRun: run });
    const healthy = schedule({ id: "sched-2", lastRun: { ...run, id: "r", status: "succeeded" } });
    const { items } = inbox({ schedules: [failed, healthy] });
    expect(items).toEqual([
      expect.objectContaining({
        kind: "schedule_error",
        id: "srv:sched-1|schedule_error|run-3",
        scheduleId: "sched-1",
        workspaceId: "ws-9",
        error: "Slack token expired",
        title: "Daily",
      }),
    ]);
  });

  it("flags red checks on open change requests and counts them", () => {
    const { items } = inbox({
      sessions: [
        session({
          pullRequests: [
            pr({ number: 10, state: "merged", checksStatus: "failure" }),
            pr({ number: 11, checksStatus: "failure" }),
            pr({ number: 12, checksStatus: "failure" }),
          ],
        }),
      ],
    });
    expect(items).toEqual([
      expect.objectContaining({
        kind: "checks_failed",
        id: "srv:ws-1|checks_failed|11,12",
        failingCount: 2,
        pullRequest: expect.objectContaining({ number: 11 }),
      }),
    ]);
  });

  it("offers the lowest open layer of a stack for merge once it is green and not a draft", () => {
    const ready = inbox({
      sessions: [
        session({
          pullRequests: [
            pr({ number: 20, state: "merged" }),
            pr({ number: 21, checksStatus: "success" }),
            pr({ number: 22, checksStatus: "success" }),
          ],
        }),
      ],
    });
    expect(ready.items).toEqual([
      expect.objectContaining({
        kind: "merge_ready",
        pullRequest: expect.objectContaining({ number: 21 }),
      }),
    ]);

    const draft = inbox({
      sessions: [session({ pullRequests: [pr({ checksStatus: "success", isDraft: true })] })],
    });
    expect(draft.items).toEqual([]);

    const blocked = inbox({
      sessions: [
        session({ pullRequests: [pr({ number: 1 }), pr({ number: 2, checksStatus: "success" })] }),
      ],
    });
    expect(blocked.items).toEqual([]);
  });

  it("lists a finished, unread session", () => {
    const { items } = inbox({
      sessions: [session({ bucket: "attention", agents: [agent({ bucket: "attention" })] })],
    });
    expect(kinds(items)).toEqual(["finished"]);
  });

  it("points a handed-back row at the agent that spoke last, for its context and reply", () => {
    const { items } = inbox({
      sessions: [
        session({
          bucket: "attention",
          agents: [
            agent({ id: "planner", bucket: "done", lastActivityAt: new Date(NOW - 600_000) }),
            agent({ id: "dev", bucket: "attention", lastActivityAt: new Date(NOW - 60_000) }),
          ],
        }),
      ],
    });
    expect(items).toEqual([expect.objectContaining({ kind: "finished", agentId: "dev" })]);
  });

  it("leaves out sessions whose agents talk to Boss or run on a timer", () => {
    const worker = session({
      bucket: "needs_input",
      agents: [agent({ bucket: "needs_input", personFacing: false })],
    });
    expect(inbox({ sessions: [worker] }).items).toEqual([]);

    const mixed = session({
      bucket: "needs_input",
      agents: [
        agent({ id: "dev", bucket: "needs_input", personFacing: false }),
        agent({ id: "boss", bucket: "attention", lastActivityAt: new Date(NOW - 30_000) }),
      ],
    });
    expect(inbox({ sessions: [mixed] }).items).toEqual([
      expect.objectContaining({ kind: "finished", agentId: "boss" }),
    ]);
  });

  it.each(["needs_input", "failed", "running", "attention", "done"] as const)(
    "leaves a workspace without a chat out of the inbox even with PR alerts and %s status",
    (bucket) => {
      const empty = session({
        bucket,
        agents: [],
        pullRequests: [
          pr({ number: 21, checksStatus: "success" }),
          pr({ number: 22, checksStatus: "failure" }),
        ],
      });
      expect(inbox({ sessions: [empty] }).items).toEqual([]);
    },
  );

  it("drops a handback the daemon sorted as a plain report and shows what a question needs", () => {
    const handedBack = { bucket: "attention" as const, agents: [agent({ bucket: "attention" })] };
    const report = session({
      ...handedBack,
      handoff: { agentId: "agent-1", kind: "report", need: null, at: new Date(NOW - 50_000) },
    });
    expect(inbox({ sessions: [report] }).items).toEqual([]);

    const question = session({
      ...handedBack,
      handoff: {
        agentId: "agent-1",
        kind: "question",
        need: "Soll ich die Datenbank auch löschen?",
        at: new Date(NOW - 50_000),
      },
    });
    expect(inbox({ sessions: [question] }).items).toEqual([
      expect.objectContaining({
        kind: "finished",
        handoffKind: "question",
        need: "Soll ich die Datenbank auch löschen?",
      }),
    ]);

    // A sorting from an earlier turn says nothing about the current one.
    const stale = session({
      ...handedBack,
      handoff: { agentId: "agent-1", kind: "report", need: null, at: new Date(NOW - 3_600_000) },
    });
    expect(inbox({ sessions: [stale] }).items).toEqual([
      expect.objectContaining({ kind: "finished", handoffKind: null }),
    ]);
  });

  it("keeps a handed-back session after it was looked at, until it is marked done", () => {
    const seen = session({ bucket: "done", agents: [agent({ bucket: "done" })] });
    expect(kinds(inbox({ sessions: [seen] }).items)).toEqual(["finished"]);

    const markedDone = { ...seen, doneAt: new Date(NOW - 30_000) };
    expect(inbox({ sessions: [markedDone] }).items).toEqual([]);

    const workedAgain = { ...markedDone, handedBackAt: new Date(NOW - 10_000) };
    expect(kinds(inbox({ sessions: [workedAgain] }).items)).toEqual(["finished"]);
  });

  it("closes an open question when the session is marked done", () => {
    const asked = session({ bucket: "needs_input", doneAt: new Date(NOW - 30_000) });
    expect(inbox({ sessions: [asked] }).items).toEqual([]);
  });

  it("lets a long-untouched session leave the inbox", () => {
    const old = session({
      bucket: "done",
      handedBackAt: new Date(NOW - WAITING_INBOX_WINDOW_MS - 1),
    });
    expect(inbox({ sessions: [old] }).items).toEqual([]);
    expect(inbox({ sessions: [{ ...old, agents: [] }] }).items).toEqual([]);
  });

  it("drops an item as soon as its reason is gone", () => {
    const waiting = session({ bucket: "needs_input" });
    expect(kinds(inbox({ sessions: [waiting] }).items)).toEqual(["question"]);
    expect(inbox({ sessions: [{ ...waiting, bucket: "running" }] }).items).toEqual([]);
    expect(inbox({ sessions: [] }).items).toEqual([]);
  });

  it("sorts by urgency, then by who waited longest", () => {
    const { items } = inbox({
      sessions: [
        session({ key: "s:done", bucket: "attention", since: new Date(NOW - 10_000) }),
        session({ key: "s:q-new", bucket: "needs_input", since: new Date(NOW - 1_000) }),
        session({ key: "s:q-old", bucket: "needs_input", since: new Date(NOW - 50_000) }),
        session({ key: "s:err", bucket: "failed", since: new Date(NOW - 5_000) }),
        session({ key: "s:merge", pullRequests: [pr({ checksStatus: "success" })] }),
      ],
    });
    expect(items.map((item) => `${item.kind}:${item.id.split("|")[0]}`)).toEqual([
      "question:s:q-old",
      "question:s:q-new",
      "agent_error:s:err",
      "merge_ready:s:merge",
      "finished:s:done",
    ]);
  });
});

describe("snooze", () => {
  const waiting = session({ bucket: "needs_input", since: new Date(NOW - 60_000) });
  const id = `srv:ws-1|question|${NOW - 60_000}`;

  it("hides a snoozed item until the snooze runs out, then brings it back", () => {
    const until = NOW + 3_600_000;
    const hidden = inbox({ sessions: [waiting], snoozedUntil: { [id]: until } });
    expect(hidden.items).toEqual([]);
    expect(hidden.snoozedCount).toBe(1);
    expect(hidden.nextWakeAt).toBe(until);

    const back = inbox({ sessions: [waiting], snoozedUntil: { [id]: until }, nowMs: until });
    expect(kinds(back.items)).toEqual(["question"]);
    expect(back.nextWakeAt).toBeNull();
  });

  it("does not cover a new reason on the same session", () => {
    const newQuestion = { ...waiting, since: new Date(NOW - 5_000) };
    const result = inbox({ sessions: [newQuestion], snoozedUntil: { [id]: NOW + 3_600_000 } });
    expect(kinds(result.items)).toEqual(["question"]);
  });

  it("covers exactly one kind: a snoozed question leaves the merge-ready change visible", () => {
    const both = { ...waiting, pullRequests: [pr({ checksStatus: "success" })] };
    const result = inbox({ sessions: [both], snoozedUntil: { [id]: NOW + 3_600_000 } });
    expect(kinds(result.items)).toEqual(["merge_ready"]);
  });

  it("offers an hour, tonight at 18:00 and tomorrow at 08:00", () => {
    const afternoon = new Date(2026, 8, 30, 14, 10);
    expect(availableSnoozeOptions(afternoon)).toEqual(["hour", "evening", "morning"]);
    expect(snoozeUntil("hour", afternoon)).toEqual(new Date(2026, 8, 30, 15, 10));
    expect(snoozeUntil("evening", afternoon)).toEqual(new Date(2026, 8, 30, 18, 0));
    expect(snoozeUntil("morning", afternoon)).toEqual(new Date(2026, 9, 1, 8, 0));
  });

  it("drops tonight once the evening has begun and keeps morning on the next 08:00", () => {
    const night = new Date(2026, 8, 30, 19, 0);
    expect(availableSnoozeOptions(night)).toEqual(["hour", "morning"]);
    const earlyMorning = new Date(2026, 9, 1, 2, 0);
    expect(snoozeUntil("morning", earlyMorning)).toEqual(new Date(2026, 9, 1, 8, 0));
  });
});

describe("deriveLeitstandMood", () => {
  it("is startled by errors, raises a paw for decisions, chews while agents run, else sleeps", () => {
    const err = inbox({
      sessions: [session({ bucket: "failed" }), session({ key: "k", bucket: "needs_input" })],
    });
    expect(deriveLeitstandMood({ items: err.items, runningAgentCount: 3 })).toBe("err");
    const ask = inbox({ sessions: [session({ bucket: "needs_input" })] });
    expect(deriveLeitstandMood({ items: ask.items, runningAgentCount: 3 })).toBe("ask");
    const finished = inbox({ sessions: [session({ bucket: "attention" })] });
    expect(deriveLeitstandMood({ items: finished.items, runningAgentCount: 1 })).toBe("run");
    expect(deriveLeitstandMood({ items: finished.items, runningAgentCount: 0 })).toBe("ask");
    expect(deriveLeitstandMood({ items: [], runningAgentCount: 0 })).toBe("sleep");
  });
});
