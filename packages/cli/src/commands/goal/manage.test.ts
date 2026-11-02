import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test, vi } from "vitest";
import { runChangesCommand } from "./changes.js";
import { buildConfigChanges } from "./config.js";
import { createGoalCommand } from "./index.js";
import { parseGoalListFilter } from "./ls.js";
import { confirmGoalDelete, describeRetained } from "./manage.js";
import type { Goal, GoalEvent } from "@getpaseo/protocol/goal/types";
import { goalRevisionRows, goalWaitLines, verificationRoundLine } from "./inspect.js";
import { describeBlockingLimits, runDiagnoseCommand, runRecoverCommand } from "./recover.js";
import { connectGoalClient } from "./shared.js";
import {
  askTimeMode,
  isTimeLimitRefusal,
  parseGuidance,
  parseRevisionFile,
  parseTimeMode,
  reopenedReworks,
  revisionToDecide,
  runRetryCommand,
  runReviseCommand,
  toRevisionRow,
} from "./transition.js";

vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  connectGoalClient: vi.fn(),
}));

describe("goal ls filters", () => {
  test("no flags sends no filter", () => {
    expect(parseGoalListFilter({} as never)).toEqual({});
  });

  test("flags map to goal.list filters; the project path is made absolute", () => {
    expect(
      parseGoalListFilter({
        search: "login",
        status: ["failed", "cancelled"],
        priority: ["high"],
        archived: "only",
        project: "repo",
      } as never),
    ).toEqual({
      query: "login",
      status: ["failed", "cancelled"],
      priority: ["high"],
      archived: "only",
      cwd: path.resolve("repo"),
    });
  });

  test("an unknown value is refused before anything is sent", () => {
    expect(() => parseGoalListFilter({ status: ["done"] } as never)).toThrow(
      /--status must be one of planning/,
    );
    expect(() => parseGoalListFilter({ priority: ["urgent"] } as never)).toThrow(
      /--priority must be one of low, normal, high/,
    );
    expect(() => parseGoalListFilter({ archived: "all" } as never)).toThrow(
      /--archived must be one of exclude, only, include/,
    );
  });
});

describe("goal delete confirmation", () => {
  const asked: string[] = [];
  const terminal = (answer: boolean) => ({
    interactive: true,
    structured: false,
    confirm: async (message: string) => {
      asked.push(message);
      return answer;
    },
  });

  test("--yes skips the question", async () => {
    asked.length = 0;
    expect(await confirmGoalDelete("g1", { yes: true }, terminal(false))).toBe(true);
    expect(asked).toEqual([]);
  });

  test("a terminal is asked, and the answer decides", async () => {
    asked.length = 0;
    expect(await confirmGoalDelete("g1", {}, terminal(false))).toBe(false);
    expect(await confirmGoalDelete("g1", {}, terminal(true))).toBe(true);
    expect(asked[0]).toContain("Delete goal g1");
  });

  test("without a terminal, or with JSON output, --yes is required", async () => {
    await expect(
      confirmGoalDelete("g1", {}, { ...terminal(true), interactive: false }),
    ).rejects.toThrow(/rerun with --yes/);
    await expect(
      confirmGoalDelete("g1", {}, { ...terminal(true), structured: true }),
    ).rejects.toThrow(/rerun with --yes/);
  });

  test("what delete left in place is listed", () => {
    expect(describeRetained([])).toBe("-");
    expect(
      describeRetained([
        { kind: "branch", name: "paseo-goal/g1", reason: "Branches are never deleted" },
        { kind: "worktree", name: "/wt/a", reason: "It has uncommitted changes" },
      ]),
    ).toBe(
      "branch paseo-goal/g1 (Branches are never deleted); worktree /wt/a (It has uncommitted changes)",
    );
  });
});

describe("goal config flags", () => {
  test("only the flags given become changes; none clears an optional setting", () => {
    expect(
      buildConfigChanges({
        onPermission: "auto",
        notifyLead: false,
        maxParallel: "3",
        maxRework: "none",
        testCommand: "none",
        maxRuns: "120",
        maxCost: "2.5",
        maxTokens: "none",
        deadline: "2026-12-01T00:00:00Z",
      } as never),
    ).toEqual({
      onPermissionRequest: "auto",
      notifyLead: false,
      maxParallel: 3,
      maxReworkRounds: null,
      testCommand: null,
      limits: {
        maxRuns: 120,
        maxCostUsd: 2.5,
        maxTotalTokens: null,
        deadlineAt: "2026-12-01T00:00:00Z",
      },
    });
  });

  test("a bad value or no change is refused before anything is sent", () => {
    expect(() => buildConfigChanges({ onPermission: "ask" } as never)).toThrow(
      /--on-permission must be one of fail, wait, auto/,
    );
    expect(() => buildConfigChanges({ maxRuns: "many" } as never)).toThrow(
      /--max-runs must be a number or none/,
    );
    expect(() => buildConfigChanges({ maxParallel: "none" } as never)).toThrow(
      /--max-parallel cannot be cleared/,
    );
    expect(() => buildConfigChanges({} as never)).toThrow(/at least one setting/);
  });
});

describe("goal lead interventions flags", () => {
  test("config changes the setting only when a flag is given", () => {
    expect(buildConfigChanges({ leadInterventions: false } as never)).toEqual({
      leadInterventions: false,
    });
    expect(buildConfigChanges({ leadInterventions: true } as never)).toEqual({
      leadInterventions: true,
    });
  });

  test("create leaves the default to the daemon unless a flag is given", () => {
    const cases: [string[], boolean | undefined][] = [
      [[], undefined],
      [["--no-lead-interventions"], false],
      [["--lead-interventions"], true],
    ];
    for (const [args, expected] of cases) {
      const create = createGoalCommand().commands.find((command) => command.name() === "create");
      create?.parseOptions(args);
      expect(create?.opts().leadInterventions).toBe(expected);
    }
  });
});

describe("goal user-wait flag", () => {
  test("config sets the limit, or clears it with none", () => {
    expect(buildConfigChanges({ userWait: "30" } as never)).toEqual({
      limits: { userWaitMinutes: 30 },
    });
    expect(buildConfigChanges({ userWait: "none" } as never)).toEqual({
      limits: { userWaitMinutes: null },
    });
    expect(() => buildConfigChanges({ userWait: "soon" } as never)).toThrow(
      /--user-wait must be a number or none/,
    );
  });

  test("create and config take --user-wait", () => {
    for (const name of ["create", "config"]) {
      const command = createGoalCommand().commands.find((c) => c.name() === name);
      command?.parseOptions(["--user-wait", "45"]);
      expect(command?.opts().userWait).toBe("45");
    }
  });
});

describe("waits in goal inspect", () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 28, 6, minute)).toISOString();
  const event = (seq: number, minute: number, fields: Record<string, unknown>) =>
    ({ id: `g1-${seq}`, goalId: "g1", seq, at: at(minute), ...fields }) as GoalEvent;

  test("lists each wait, the daemon downtime inside one, and the time left out", () => {
    const events = [
      event(1, 0, { type: "wait.started", agentId: "w1", role: "worker", runId: "t5-a3" }),
      event(2, 10, { type: "usage.recorded", role: "lead", agentId: "lead" }),
      event(3, 70, {
        id: "g1:wait:w1:2:restarted",
        type: "wait.ended",
        agentId: "w1",
        outcome: "turn_ended",
      }),
      event(4, 80, { type: "wait.started", agentId: "lead", role: "lead" }),
    ];
    const goal = {
      runs: [{ id: "t5-a3", taskId: "t5" }],
      waits: { open: { lead: { since: at(80) } }, excludedMs: 70 * 60_000, since: at(80) },
    } as unknown as Goal;
    expect(goalWaitLines(goal, events, Date.parse(at(95)))).toEqual([
      "Waited for an answer, t5 (t5-a3): 1h 10m (includes daemon downtime 1h 00m)",
      "Waiting for an answer, lead: 15m 00s so far",
      "Not counted toward the time limits: 1h 25m waiting for answers",
    ]);
  });

  test("two waits closed at one restart both count the downtime from before the restart", () => {
    const events = [
      event(1, 0, { type: "wait.started", agentId: "w1", role: "worker", runId: "t5-a3" }),
      event(2, 5, { type: "wait.started", agentId: "lead", role: "lead" }),
      event(3, 70, {
        id: "g1:wait:w1:2:restarted",
        type: "wait.ended",
        agentId: "w1",
        outcome: "turn_ended",
      }),
      event(4, 70, {
        id: "g1:wait:lead:3:restarted",
        type: "wait.ended",
        agentId: "lead",
        outcome: "turn_ended",
      }),
    ];
    const goal = { runs: [{ id: "t5-a3", taskId: "t5" }] } as unknown as Goal;
    expect(goalWaitLines(goal, events, Date.parse(at(80)))).toEqual([
      "Waited for an answer, t5 (t5-a3): 1h 10m (includes daemon downtime 1h 05m)",
      "Waited for an answer, lead: 1h 05m (includes daemon downtime 1h 05m)",
    ]);
  });

  test("an accepted goal closes its waits", () => {
    const events = [
      event(1, 0, { type: "wait.started", agentId: "lead", role: "lead" }),
      event(2, 10, {
        type: "goal.accepted",
        criterionIds: [],
        note: "n",
        acceptedFrom: "r",
        client: "cli",
      }),
    ];
    expect(goalWaitLines({ runs: [] }, events, Date.parse(at(30)))).toEqual([
      "Waited for an answer, lead: 10m 00s",
    ]);
  });

  test("a goal that never waited shows nothing", () => {
    expect(goalWaitLines({ runs: [] }, [], Date.now())).toEqual([]);
  });
});

describe("goal retry help", () => {
  test("says a failed merge is retried and a review rejection is not", () => {
    const retry = createGoalCommand().commands.find((command) => command.name() === "retry");
    const help = retry?.description() ?? "";
    expect(help).toContain("merges again change sets whose merge failed");
    expect(help).toContain("reworks again change sets whose rework failed");
    expect(help).toContain("A change set rejected by review is not retried");
  });
});

describe("a failed rework in the CLI", () => {
  const AT = "2026-10-28T06:00:00.000Z";
  const changeSet = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
    id,
    taskId: "t7",
    runId: "t7-a1",
    round: 0,
    supersedes: null,
    workspaceId: "ws",
    cwd: "/w",
    branch: "b",
    baseCommit: "base000",
    headCommit: "head000",
    files: [],
    status,
    findings: null,
    testSummary: null,
    integratedCommit: null,
    error: null,
    createdAt: AT,
    updatedAt: AT,
    ...extra,
  });

  test("goal changes labels a change set whose rework failed", async () => {
    const changeSets = [
      changeSet("cs-a", "rejected", { rejectionReason: "rework_failed" }),
      changeSet("cs-b", "rejected", { rejectionReason: "rework_limit" }),
      changeSet("cs-c", "rejected"),
    ];
    vi.mocked(connectGoalClient).mockResolvedValue({
      goalInspect: async () => ({ goal: { changeSets, integration: null }, error: null }),
      close: async () => {},
    } as never);
    const result = await runChangesCommand("g1", {} as never, {} as never);
    expect(result.data.map((row) => row.status)).toEqual([
      "rejected (rework failed)",
      "rejected",
      "rejected",
    ]);
  });

  test("retry names the change sets whose rework it reopened", () => {
    const later = "2026-10-28T07:00:00.000Z";
    const goal = {
      updatedAt: later,
      changeSets: [
        changeSet("cs-t7-a1", "changes_requested", { updatedAt: later }),
        // Waiting for rework since before the retry, and approved again by it: not named.
        changeSet("cs-t8-a1", "conflicted"),
        changeSet("cs-t9-a1", "approved", { updatedAt: later }),
      ],
      tasks: [
        {
          id: "t7-rw1",
          rework: { changeSetId: "cs-t7-a1", reason: "review", round: 1 },
        },
      ],
    } as unknown as Goal;
    expect(reopenedReworks(goal)).toEqual(["Reopens the rework of cs-t7-a1 (task t7-rw1)"]);
  });
});

describe("goal retry --time", () => {
  const passed = new Error(
    "the goal's time limit has passed; choose time mode fresh (…) or remaining (…)",
  );
  const terminal = (answer: string) => ({
    interactive: true,
    structured: false,
    ask: async () => answer,
  });

  test("parses fresh and remaining, and refuses anything else", () => {
    expect(parseTimeMode(undefined)).toBeUndefined();
    expect(parseTimeMode("fresh")).toBe("fresh");
    expect(parseTimeMode(" Remaining ")).toBe("remaining");
    expect(() => parseTimeMode("later")).toThrow("--time must be fresh or remaining");
  });

  test("a refusal for a passed time limit asks on a terminal which mode to use", async () => {
    expect(await askTimeMode(passed, terminal("f"))).toBe("fresh");
    expect(await askTimeMode(passed, terminal("remaining"))).toBe("remaining");
    expect(await askTimeMode(passed, terminal(""))).toBeNull();
    // Nothing is asked for another refusal, without a terminal, or with JSON output.
    expect(await askTimeMode(new Error("the run limit of 1 is used up"), terminal("f"))).toBeNull();
    expect(await askTimeMode(passed, { ...terminal("f"), interactive: false })).toBeNull();
    expect(await askTimeMode(passed, { ...terminal("f"), structured: true })).toBeNull();
  });

  function fakeClient(supportsTimeBase: boolean) {
    const sent: Record<string, unknown>[] = [];
    vi.mocked(connectGoalClient).mockResolvedValue({
      supportsGoalTimeBase: () => supportsTimeBase,
      goalRetry: async (request: Record<string, unknown>) => {
        sent.push(request);
        return { goal: null, error: passed.message };
      },
      close: async () => {},
    } as never);
    return sent;
  }

  test("--time is sent with the retry; without a terminal the refusal names both flags", async () => {
    const sent = fakeClient(true);
    await expect(
      runRetryCommand("g1", { time: "remaining" } as never, {} as never),
    ).rejects.toMatchObject({ code: "GOAL_RETRY_FAILED" });
    expect(sent[0]).toEqual({ goalId: "g1", timeMode: "remaining" });
    await expect(runRetryCommand("g1", { json: true } as never, {} as never)).rejects.toMatchObject(
      { message: expect.stringContaining("rerun with --time fresh or --time remaining") },
    );
    expect(sent[1]).toEqual({ goalId: "g1" });
    expect(sent).toHaveLength(2);
    await expect(runRetryCommand("g1", { time: "x" } as never, {} as never)).rejects.toMatchObject({
      message: expect.stringContaining("--time must be fresh or remaining"),
    });
    expect(sent).toHaveLength(2);
  });

  test("against a host without goalTimeBase nothing is asked; the refusal says to update it", async () => {
    const sent = fakeClient(false);
    await expect(runRetryCommand("g1", {} as never, {} as never)).rejects.toMatchObject({
      message: expect.stringContaining("Update the host to choose how a retried goal's time limit"),
    });
    expect(sent).toEqual([{ goalId: "g1" }]);
  });
});

describe("goal revise", () => {
  const spec = { id: "t7a", title: "A", description: "", kind: "implement", dependsOn: [] };

  test("reads an ops array, {ops}, or the desired plan with remove", () => {
    const ops = [
      { op: "add", task: spec },
      { op: "remove", taskId: "t7" },
    ];
    expect(parseRevisionFile(JSON.stringify(ops), { reason: "split t7" })).toEqual({
      ops,
      reason: "split t7",
    });
    expect(parseRevisionFile(JSON.stringify({ ops, reason: "from file" }), {})).toMatchObject({
      reason: "from file",
    });
    expect(
      parseRevisionFile(JSON.stringify({ tasks: [spec], remove: ["t7"], reason: "x" }), {
        reason: "flag wins",
      }),
    ).toEqual({ tasks: [spec], remove: ["t7"], reason: "flag wins" });
  });

  test("sends the calling agent's id, and needs a reason", () => {
    const ops = JSON.stringify([{ op: "remove", taskId: "t7" }]);
    expect(parseRevisionFile(ops, { reason: "r", agentId: "lead-1" })).toMatchObject({
      agentId: "lead-1",
    });
    expect(parseRevisionFile(ops, { reason: "r", agentId: " " })).not.toHaveProperty("agentId");
    expect(() => parseRevisionFile(ops, {})).toThrow(/--reason/);
    expect(() =>
      parseRevisionFile(JSON.stringify({ ops: [], tasks: [] }), { reason: "r" }),
    ).toThrow();
  });

  test("approve-revision and reject-revision default to the pending revision", () => {
    const goal = {
      id: "g1",
      planRevisions: [
        { id: "rev-1", status: "applied" },
        { id: "rev-2", status: "pending" },
      ],
    } as never;
    expect(revisionToDecide(goal)).toBe("rev-2");
    expect(revisionToDecide(goal, "rev-9")).toBe("rev-9");
    expect(() => revisionToDecide({ id: "g1" })).toThrow(/no plan revision waiting/);
    const names = createGoalCommand().commands.map((command) => command.name());
    expect(names).toEqual(
      expect.arrayContaining(["revise", "approve-revision", "reject-revision"]),
    );
  });
});

describe("goal revise outcome", () => {
  let dir = "";
  const revisionFile = async () => {
    dir = await mkdtemp(path.join(tmpdir(), "paseo-goal-revise-"));
    const file = path.join(dir, "revision.json");
    await writeFile(file, JSON.stringify([{ op: "remove", taskId: "t7" }]));
    return file;
  };
  afterEach(async () => {
    vi.unstubAllEnvs();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  /** A client whose goalRevisePlan answers with the revision in `status`. */
  function fakeClient(status: string, decisionReason?: string) {
    const sent: Record<string, unknown>[] = [];
    const client = {
      goalRevisePlan: async (request: Record<string, unknown>) => {
        sent.push(request);
        const revision = {
          id: `rev-${String(request.eventId)}`,
          source: request.agentId ? "lead" : "person",
          reason: "r",
          ops: [],
          status,
          proposedAt: "x",
          ...(decisionReason ? { decisionReason } : {}),
        };
        return { goal: { id: "g1", planRevisions: [revision] }, error: null };
      },
      close: async () => {},
    };
    vi.mocked(connectGoalClient).mockResolvedValue(client as never);
    return sent;
  }

  test("sends PASEO_AGENT_ID and reports a revision waiting for approval", async () => {
    vi.stubEnv("PASEO_AGENT_ID", "lead-1");
    const sent = fakeClient("pending");
    const result = await runReviseCommand(
      "g1",
      { file: await revisionFile(), reason: "drop t7" } as never,
      {} as never,
    );
    expect(sent[0]).toMatchObject({ goalId: "g1", agentId: "lead-1", reason: "drop t7" });
    expect(result.data).toMatchObject({
      revisionId: `rev-${String(sent[0]?.eventId)}`,
      source: "lead",
      status: "pending",
      outcome: expect.stringMatching(/waiting for approval/),
    });
  });

  test("--as-person sends no agent id", async () => {
    vi.stubEnv("PASEO_AGENT_ID", "chat-agent");
    const sent = fakeClient("applied");
    await runReviseCommand(
      "g1",
      { file: await revisionFile(), reason: "drop t7", asPerson: true } as never,
      {} as never,
    );
    expect(sent[0]).not.toHaveProperty("agentId");
  });

  test("a rejected revision fails the command with the reducer's reason", async () => {
    fakeClient("rejected", "the goal's run limit of 1 is used up");
    await expect(
      runReviseCommand("g1", { file: await revisionFile(), reason: "x" } as never, {} as never),
    ).rejects.toMatchObject({
      code: "GOAL_REVISION_REJECTED",
      message: expect.stringMatching(/rejected: the goal's run limit of 1 is used up/),
    });
  });

  test("a reply without the revision is an error, and inspect lists revisions", () => {
    expect(() => toRevisionRow({ goal: { id: "g1" } as never, error: null }, "rev-1")).toThrow(
      /no plan revision rev-1/,
    );
    expect(
      goalRevisionRows({
        planRevisions: [
          {
            id: "rev-1",
            source: "lead",
            reason: "split t7\nbecause it timed out",
            ops: [],
            status: "applied",
            proposedAt: "x",
            decidedAt: "y",
          },
        ],
      }),
    ).toEqual([
      { id: "rev-1", source: "lead", status: "applied", decidedAt: "y", reason: "split t7" },
    ]);
  });

  test("inspect names the verification round once a recovery added work", () => {
    expect(verificationRoundLine({})).toBeNull();
    expect(verificationRoundLine({ verificationRound: 1 })).toBe(
      "Verification round 1: a recovery added work, so every criterion is verified again.",
    );
  });
});

describe("goal guidance flags", () => {
  test("--prompt and --task t7=text become guidance changes; an empty text clears", () => {
    expect(parseGuidance(undefined, undefined, "--task")).toBeUndefined();
    expect(parseGuidance("use screenshots", ["t7=split it", "t8= "], "--task")).toEqual({
      goal: "use screenshots",
      tasks: { t7: "split it", t8: null },
    });
    expect(parseGuidance("", [], "--task")).toEqual({ goal: null });
    expect(() => parseGuidance(undefined, ["t7"], "--task")).toThrow(
      '--task must be <taskId>=<text>, got "t7"',
    );
  });
});

describe("goal retry guidance", () => {
  afterEach(() => vi.unstubAllEnvs());

  function fakeClient() {
    const sent: Record<string, unknown>[] = [];
    vi.mocked(connectGoalClient).mockClear();
    vi.mocked(connectGoalClient).mockResolvedValue({
      supportsGoalTimeBase: () => true,
      goalRetry: async (request: Record<string, unknown>) => {
        sent.push(request);
        return { goal: failedGoal(), error: null };
      },
      close: async () => {},
    } as never);
    return sent;
  }

  test("--prompt and --task-prompt are sent as guidance", async () => {
    vi.stubEnv("PASEO_AGENT_ID", "");
    const sent = fakeClient();
    await runRetryCommand(
      "g1",
      { prompt: "pin the version", taskPrompt: ["a=use the cache"] } as never,
      {} as never,
    );
    expect(sent).toEqual([
      { goalId: "g1", guidance: { goal: "pin the version", tasks: { a: "use the cache" } } },
    ]);
  });

  test("guidance is refused in an agent's shell before anything is sent; a plain retry is not", async () => {
    vi.stubEnv("PASEO_AGENT_ID", "agent-7");
    const sent = fakeClient();
    await expect(
      runRetryCommand("g1", { prompt: "x" } as never, {} as never),
    ).rejects.toMatchObject({
      code: "GOAL_PERSON_ONLY",
      message: expect.stringContaining("PASEO_AGENT_ID is set (agent agent-7)"),
    });
    expect(connectGoalClient).not.toHaveBeenCalled();
    await runRetryCommand("g1", {} as never, {} as never);
    expect(sent).toEqual([{ goalId: "g1" }]);
  });
});

/** A goal that failed: task a failed, b waits on it, m merged. */
function failedGoal(overrides: Record<string, unknown> = {}): Goal {
  const at = "2026-10-27T09:00:00.000Z";
  return {
    id: "g1",
    title: "Ship",
    objective: "obj",
    status: "failed",
    config: {
      cwd: "/repo",
      leadProvider: "claude",
      defaultProvider: "codex",
      maxParallel: 2,
      maxAttempts: 2,
      autoApprovePlan: true,
      notifyLead: true,
      limits: { maxRuns: 3 },
    },
    leadAgentId: null,
    leadWorkspaceId: null,
    tasks: [
      {
        id: "m",
        title: "m",
        description: "",
        kind: "implement",
        dependsOn: [],
        status: "succeeded",
        attempts: 1,
        summary: "ok",
        error: null,
      },
      {
        id: "a",
        title: "a",
        description: "",
        kind: "implement",
        dependsOn: [],
        status: "failed",
        attempts: 2,
        summary: null,
        error: "boom",
      },
      {
        id: "b",
        title: "b",
        description: "",
        kind: "implement",
        dependsOn: ["a"],
        status: "pending",
        attempts: 0,
        summary: null,
        error: null,
      },
    ],
    runs: [
      { id: "m-a1", taskId: "m", status: "succeeded", provider: "codex", startedAt: at },
      {
        id: "a-a1",
        taskId: "a",
        status: "failed",
        provider: "codex",
        startedAt: at,
        error: "boom",
      },
      {
        id: "a-a2",
        taskId: "a",
        status: "failed",
        provider: "codex",
        startedAt: at,
        error: "boom",
      },
    ],
    changeSets: [],
    integration: null,
    criteria: [{ id: "c1", text: "works", verifiedAt: null, evidence: null }],
    notifications: [],
    lastSeq: 20,
    failureReason: "No task can make progress. Failed or blocked: a, b",
    failedAt: at,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  } as unknown as Goal;
}

describe("goal recover", () => {
  afterEach(() => vi.unstubAllEnvs());

  interface FakeRecoverClient {
    sent: { method: string; request: Record<string, unknown> }[];
  }

  /** A client whose recovery calls answer with `reply`, or refuse with `refusal`. */
  function fakeClient(options: {
    reply?: (method: string, request: Record<string, unknown>) => Goal;
    refusal?: string;
    inspected?: Goal;
    timeBase?: boolean;
  }): FakeRecoverClient {
    const fake: FakeRecoverClient = { sent: [] };
    const answer = (method: string) => async (request: Record<string, unknown>) => {
      fake.sent.push({ method, request });
      if (options.refusal) return { goal: null, error: options.refusal };
      return { goal: options.reply?.(method, request) ?? null, error: null };
    };
    vi.mocked(connectGoalClient).mockClear();
    vi.mocked(connectGoalClient).mockResolvedValue({
      supportsGoalTimeBase: () => options.timeBase ?? true,
      goalInspect: async () => ({
        goal: options.inspected ?? failedGoal(),
        events: [],
        error: null,
      }),
      goalRecoveryStart: answer("start"),
      goalRecoveryDecide: answer("decide"),
      goalRecoveryCancel: answer("cancel"),
      close: async () => {},
    } as never);
    return fake;
  }

  const recovering = (recovery: Record<string, unknown>) =>
    failedGoal({
      recovery: {
        id: "rec-21",
        startedAt: "x",
        startedBy: "person",
        failureReason: "boom",
        ...recovery,
      },
    });

  test("starts a recovery with the guidance and time mode, and says what happens next", async () => {
    vi.stubEnv("PASEO_AGENT_ID", "");
    const client = fakeClient({
      reply: () => recovering({ status: "deciding", timeMode: "remaining", activeMs: 3_600_000 }),
    });
    const result = await runRecoverCommand(
      "g1",
      { prompt: "use screenshots", task: ["a=retry with the cache"], time: "remaining" } as never,
      {} as never,
    );
    expect(client.sent).toEqual([
      {
        method: "start",
        request: {
          goalId: "g1",
          timeMode: "remaining",
          guidance: { goal: "use screenshots", tasks: { a: "retry with the cache" } },
          eventId: expect.any(String),
        },
      },
    ]);
    expect(result.data).toMatchObject({
      recoveryId: "rec-21",
      status: "deciding",
      time: "remaining: 1h 00m ran of 24h 00m; 23h 00m left after the recovery is applied",
      next: expect.stringContaining("a fresh Lead is deciding (up to 20 minutes"),
    });
  });

  test("a passed time limit without --time says to rerun with it; a limit refusal names the setting to raise", async () => {
    vi.stubEnv("PASEO_AGENT_ID", "");
    fakeClient({
      refusal:
        "recovery.started: the goal's time limit has passed; choose time mode fresh (…) or remaining (…)",
    });
    await expect(
      runRecoverCommand("g1", { json: true } as never, {} as never),
    ).rejects.toMatchObject({
      code: "GOAL_RECOVER_FAILED",
      message: expect.stringContaining("rerun with --time fresh or --time remaining"),
    });
    fakeClient({ refusal: "recovery.started: the run limit of 3 is used up" });
    await expect(
      runRecoverCommand("g1", { time: "fresh" } as never, {} as never),
    ).rejects.toMatchObject({
      message: expect.stringContaining(
        "maxRuns: 3, 3 used; at least 7: paseo goal config g1 --max-runs 7",
      ),
    });
  });

  test("a time limit that passes while the Lead decides asks for a time mode too", async () => {
    const refusal = new Error(
      "recovery.started: the Lead has 20 minutes to decide, and by then the goal's time limit has passed; choose time mode fresh or remaining",
    );
    expect(isTimeLimitRefusal(refusal)).toBe(true);
    expect(
      await askTimeMode(refusal, { interactive: true, structured: false, ask: async () => "r" }),
    ).toBe("remaining");
  });

  test("is refused in an agent's shell before anything is sent", async () => {
    vi.stubEnv("PASEO_AGENT_ID", "agent-7");
    fakeClient({});
    await expect(runRecoverCommand("g1", {} as never, {} as never)).rejects.toMatchObject({
      code: "GOAL_PERSON_ONLY",
      message: expect.stringContaining("paseo goal recover is for a person"),
    });
    expect(connectGoalClient).not.toHaveBeenCalled();
  });

  test("refuses flags that do not go together", async () => {
    vi.stubEnv("PASEO_AGENT_ID", "");
    fakeClient({});
    await expect(
      runRecoverCommand("g1", { cancel: true, approve: true } as never, {} as never),
    ).rejects.toMatchObject({ message: expect.stringContaining("Give one of --cancel") });
    await expect(
      runRecoverCommand("g1", { approve: true, time: "fresh" } as never, {} as never),
    ).rejects.toMatchObject({ message: expect.stringContaining("start a recovery") });
    await expect(
      runRecoverCommand("g1", { message: "no" } as never, {} as never),
    ).rejects.toMatchObject({ message: expect.stringContaining("--message goes with --reject") });
  });

  test("--cancel, --approve and --reject act on the open recovery", async () => {
    vi.stubEnv("PASEO_AGENT_ID", "");
    const waiting = recovering({ status: "awaiting_approval" });
    const client = fakeClient({
      inspected: waiting,
      reply: (method) =>
        method === "cancel"
          ? recovering({ status: "ended", outcome: "cancelled" })
          : recovering({ status: "applied", outcome: "applied" }),
    });
    const cancelled = await runRecoverCommand("g1", { cancel: true } as never, {} as never);
    expect(cancelled.data).toMatchObject({ status: "ended", outcome: "cancelled" });
    await runRecoverCommand("g1", { approve: true } as never, {} as never);
    await runRecoverCommand("g1", { reject: true, message: "no" } as never, {} as never);
    expect(client.sent).toEqual([
      { method: "cancel", request: { goalId: "g1", recoveryId: "rec-21" } },
      { method: "decide", request: { goalId: "g1", recoveryId: "rec-21", approve: true } },
      {
        method: "decide",
        request: { goalId: "g1", recoveryId: "rec-21", approve: false, message: "no" },
      },
    ]);
  });

  test("an approval that ended the recovery for a person exits non-zero with the reason", async () => {
    vi.stubEnv("PASEO_AGENT_ID", "");
    fakeClient({
      inspected: recovering({ status: "awaiting_approval" }),
      reply: () => ({
        ...recovering({ status: "ended", outcome: "needs_person" }),
        failureReason: "Recovery needs a person: The integration worktree /w is dirty",
      }),
    });
    await expect(
      runRecoverCommand("g1", { approve: true } as never, {} as never),
    ).rejects.toMatchObject({
      code: "GOAL_RECOVERY_NOT_APPLIED",
      message:
        "Recovery rec-21 was not applied: Recovery needs a person: The integration worktree /w is dirty",
    });
  });

  test("diagnose explains the failure and the limits to raise", async () => {
    vi.stubEnv("PASEO_AGENT_ID", "");
    fakeClient({});
    const result = await runDiagnoseCommand("g1", {} as never, {} as never);
    expect(result.data).toMatchObject({ kind: "run_limit", blocked: ["b"] });
    const text = result.schema.renderHuman?.(result, {} as never) ?? "";
    expect(text).toContain("a failed, worker_error: 2 failed (2 counted), 0 interrupted; blocks b");
    expect(text).toContain("maxRuns: 3, 3 used; at least 7: paseo goal config g1 --max-runs 7");
    expect(text).toContain("Recover: paseo goal recover g1");
    expect(result.schema.serialize?.(result.data)).toMatchObject({
      goalId: "g1",
      kind: "run_limit",
    });
    expect(
      describeBlockingLimits("g1", [{ limit: "deadlineAt", current: null, note: "set one" }]),
    ).toEqual(["deadlineAt: none (set one)"]);
    const names = createGoalCommand().commands.map((command) => command.name());
    expect(names).toEqual(expect.arrayContaining(["diagnose", "recover"]));
  });
});
