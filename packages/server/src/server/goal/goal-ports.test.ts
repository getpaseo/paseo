import { describe, expect, test, vi } from "vitest";
import pino from "pino";
import {
  createGoalAgentPort,
  createGoalWorkspacePort,
  createTurnUsageMeter,
  goalPolicyModeId,
  readActivityDigest,
  readTimelineCursor,
  settleTurn,
  toTurnUsage,
  waitForNoRun,
  watchTurn,
  type GoalPortDeps,
} from "./goal-ports.js";
import type { AgentManagerEvent } from "../agent/agent-manager.js";
import { InMemoryAgentTimelineStore } from "../agent/agent-timeline-store.js";
import type { AgentTimelineFetchOptions } from "../agent/agent-timeline-store-types.js";
import type { GoalMode } from "./goal-config-validation.js";

const done = (lastMessage: string) => ({ status: "idle", permission: null, lastMessage });
const asking = { status: "running", permission: { id: "p1" }, lastMessage: null };

function sequence<T>(...results: T[]): () => Promise<T> {
  let index = 0;
  return async () => results[Math.min(index++, results.length - 1)] as T;
}

describe("settleTurn", () => {
  test("a finished turn returns the agent's last message, trimmed", async () => {
    expect(await settleTurn(sequence(done("  built it \n")), "fail", "a1")).toEqual({
      outcome: "completed",
      text: "built it",
    });
  });

  test("an agent error becomes a failure carrying its message", async () => {
    const result = await settleTurn(
      sequence({ status: "error", permission: null, lastMessage: "quota exceeded" }),
      "fail",
      "a1",
    );
    expect(result).toEqual({ outcome: "failed", error: "quota exceeded" });
  });

  test("under the fail policy a permission request ends the turn at once", async () => {
    const pauses: number[] = [];
    const result = await settleTurn(sequence(asking), "fail", "a1", async (ms) => {
      pauses.push(ms);
    });
    expect(result).toMatchObject({ outcome: "needs_permission" });
    expect(pauses).toEqual([]);
  });

  test("under the wait policy it keeps waiting until a person has answered", async () => {
    const pauses: number[] = [];
    const result = await settleTurn(
      sequence(asking, asking, asking, done("finished after approval")),
      "wait",
      "a1",
      async (ms) => {
        pauses.push(ms);
      },
    );
    expect(result).toEqual({ outcome: "completed", text: "finished after approval" });
    expect(pauses).toEqual([1000, 1000, 1000]);
  });

  test("a waiting turn ends once the goal is switched to fail", async () => {
    let policy: "fail" | "wait" = "wait";
    let polls = 0;
    const result = await settleTurn(
      sequence(asking),
      () => policy,
      "a1",
      async () => {
        polls += 1;
        if (polls === 2) policy = "fail";
      },
    );
    expect(result).toMatchObject({ outcome: "needs_permission" });
    expect(polls).toBe(2);
  });

  test("a request left pending on an agent that has stopped does not loop forever", async () => {
    // After the caller cancels the agent, the request can still be reported.
    const stopped = { status: "idle", permission: { id: "p1" }, lastMessage: null };
    const result = await settleTurn(sequence(asking, stopped), "wait", "a1", async () => {});
    expect(result).toMatchObject({ outcome: "needs_permission" });
  });

  // Shaped like Codex's request_user_input: the question rides in input.questions.
  const question = {
    id: "permission-q1",
    name: "request_user_input",
    kind: "question" as const,
    title: "Question",
    input: {
      questions: [{ id: "0", header: "Question 1", question: "Record a setup decision?" }],
    },
  };

  test("under fail a question ends the turn and says what was asked", async () => {
    const result = await settleTurn(
      sequence({ status: "running", permission: question, lastMessage: null }),
      "fail",
      "a1",
      async () => {},
    );
    expect(result).toEqual({
      outcome: "needs_permission",
      request: { kind: "question", tool: "request_user_input", text: "Record a setup decision?" },
    });
  });

  test("a permission says which tool and what for, cut to 300 characters", async () => {
    const command = `rm -rf ${"x".repeat(400)}`;
    const result = await settleTurn(
      sequence({
        status: "running",
        permission: {
          id: "p2",
          name: "Bash",
          kind: "tool",
          detail: { type: "shell", command },
        },
        lastMessage: null,
      }),
      "fail",
      "a1",
    );
    expect(result).toMatchObject({
      outcome: "needs_permission",
      request: { kind: "permission", tool: "Bash" },
    });
    const text = result.outcome === "needs_permission" ? result.request?.text : undefined;
    expect(text).toHaveLength(300);
    expect(text?.startsWith("rm -rf xxx")).toBe(true);
  });

  test("under wait a question asked while the turn runs keeps it waiting", async () => {
    const pauses: number[] = [];
    const result = await settleTurn(
      sequence(
        { status: "running", permission: question, lastMessage: null },
        { status: "running", permission: question, lastMessage: null },
        done("answered and done"),
      ),
      "wait",
      "a1",
      async (ms) => {
        pauses.push(ms);
      },
    );
    expect(result).toEqual({ outcome: "completed", text: "answered and done" });
    expect(pauses).toEqual([1000, 1000]);
  });

  test("under wait a question left open after the turn waits, then for the turn its answer starts", async () => {
    // Codex's async questions: the turn ends, the question stays, the answer starts a new turn.
    const waiting = { status: "idle", permission: question, lastMessage: "Which setup?" };
    const answered = { status: "idle", permission: null, lastMessage: "Which setup?" };
    const result = await settleTurn(
      sequence(waiting, waiting, answered, done("did the work after the answer")),
      "wait",
      "a1",
      async () => {},
    );
    expect(result).toEqual({ outcome: "completed", text: "did the work after the answer" });
  });

  test("an abandoned turn stops polling for a request nobody will answer", async () => {
    const controller = new AbortController();
    let polls = 0;
    const result = await settleTurn(
      sequence(asking),
      "wait",
      "a1",
      async () => {
        polls += 1;
        if (polls === 2) controller.abort();
      },
      controller.signal,
    );
    expect(result).toMatchObject({ outcome: "needs_permission" });
    expect(polls).toBe(2);
  });
});

describe("settleTurn onWait", () => {
  interface Change {
    waiting: boolean;
    ended?: boolean;
    tool?: string;
  }
  function recorder() {
    const changes: Change[] = [];
    return {
      changes,
      onWait: (
        change: { waiting: true; request: { tool: string } } | { waiting: false; ended?: boolean },
      ) =>
        changes.push(
          change.waiting
            ? { waiting: true, tool: change.request.tool }
            : { waiting: false, ...(change.ended ? { ended: true } : {}) },
        ),
    };
  }
  const bash = { status: "running", permission: { id: "p1", name: "Bash" }, lastMessage: null };

  test("a request that waits a poll starts a wait, and its answer ends it", async () => {
    const { changes, onWait } = recorder();
    const result = await settleTurn(
      sequence(bash, bash, bash, done("ok")),
      "wait",
      "a1",
      async () => {},
      undefined,
      onWait,
    );
    expect(result).toEqual({ outcome: "completed", text: "ok" });
    expect(changes).toEqual([{ waiting: true, tool: "Bash" }, { waiting: false }]);
  });

  test("a request that clears itself by the next poll reports nothing", async () => {
    const { changes, onWait } = recorder();
    await settleTurn(sequence(bash, done("ok")), "wait", "a1", async () => {}, undefined, onWait);
    expect(changes).toEqual([]);
  });

  test("an async question waits like a permission", async () => {
    const { changes, onWait } = recorder();
    const question = { id: "q1", name: "request_user_input", kind: "question" as const };
    const waiting = { status: "idle", permission: question, lastMessage: null };
    const answered = { status: "idle", permission: null, lastMessage: null };
    await settleTurn(
      sequence(waiting, waiting, answered, done("ok")),
      "wait",
      "a1",
      async () => {},
      undefined,
      onWait,
    );
    expect(changes).toEqual([{ waiting: true, tool: "request_user_input" }, { waiting: false }]);
  });

  test("a different request right after another is a new wait", async () => {
    const { changes, onWait } = recorder();
    const edit = { status: "running", permission: { id: "p2", name: "Edit" }, lastMessage: null };
    await settleTurn(
      sequence(bash, bash, edit, edit, done("ok")),
      "wait",
      "a1",
      async () => {},
      undefined,
      onWait,
    );
    expect(changes).toEqual([
      { waiting: true, tool: "Bash" },
      { waiting: false },
      { waiting: true, tool: "Edit" },
      { waiting: false },
    ]);
  });

  test("a turn that stops waiting ends the wait as ended, not answered", async () => {
    const { changes, onWait } = recorder();
    const controller = new AbortController();
    let polls = 0;
    const result = await settleTurn(
      sequence(bash),
      "wait",
      "a1",
      async () => {
        polls += 1;
        if (polls === 3) controller.abort();
      },
      controller.signal,
      onWait,
    );
    expect(result).toMatchObject({ outcome: "needs_permission" });
    expect(changes).toEqual([
      { waiting: true, tool: "Bash" },
      { waiting: false, ended: true },
    ]);
  });
});

describe("waitForNoRun", () => {
  /** An agent manager whose one agent is busy until `finish()`. */
  function busyAgent() {
    let busy = true;
    const listeners = new Set<(event: AgentManagerEvent) => void>();
    return {
      manager: {
        hasInFlightRun: () => busy,
        subscribe(listener: (event: AgentManagerEvent) => void) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      listeners,
      finish() {
        busy = false;
        for (const listener of listeners) listener({ type: "agent_state" } as AgentManagerEvent);
      },
    };
  }

  test("resolves at once for an idle agent and when a busy one ends its run", async () => {
    const agent = busyAgent();
    const waiting = waitForNoRun(agent.manager, "lead").then(() => "idle");
    const pause = new Promise((resolve) => setTimeout(() => resolve("busy"), 10));
    expect(await Promise.race([waiting, pause])).toBe("busy");
    agent.finish();
    expect(await waiting).toBe("idle");
    expect(agent.listeners.size).toBe(0);
    await expect(waitForNoRun(agent.manager, "lead")).resolves.toBeUndefined();
  });

  test("notices a run that ended without an event on its slow poll", async () => {
    vi.useFakeTimers();
    try {
      let busy = true;
      const manager = { hasInFlightRun: () => busy, subscribe: () => () => {} };
      let idle = false;
      const waiting = waitForNoRun(manager, "lead").then(() => {
        idle = true;
        return idle;
      });
      busy = false;
      await vi.advanceTimersByTimeAsync(1000);
      expect(await waiting).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("rejects when its signal aborts, and stops listening", async () => {
    const agent = busyAgent();
    const abort = new AbortController();
    const waiting = waitForNoRun(agent.manager, "lead", abort.signal);
    abort.abort();
    await expect(waiting).rejects.toThrow(/aborted/);
    expect(agent.listeners.size).toBe(0);
  });
});

describe("turn usage", () => {
  test("keeps the last usage the provider reported during the turn", () => {
    let emit: (event: AgentManagerEvent) => void = () => {};
    const watcher = watchTurn((listener) => {
      emit = listener;
      return () => {};
    });
    const stream = (event: unknown) =>
      emit({ type: "agent_stream", agentId: "a1", event } as unknown as AgentManagerEvent);
    stream({ type: "usage_updated", provider: "codex", usage: { inputTokens: 5 } });
    stream({
      type: "turn_completed",
      provider: "codex",
      usage: { inputTokens: 10, outputTokens: 2, totalCostUsd: 0.01, contextWindowMaxTokens: 9 },
    });
    // Reported after the turn ended: not this turn's.
    stream({ type: "usage_updated", provider: "codex", usage: { inputTokens: 99 } });
    expect(watcher.usage()).toEqual({ inputTokens: 10, outputTokens: 2, costUsd: 0.01 });
    expect(watcher.end()).toEqual({ type: "turn_completed" });
  });

  test("a turn without usage, or with only unusable numbers, reports none", () => {
    expect(toTurnUsage(undefined)).toBeUndefined();
    expect(toTurnUsage({ inputTokens: Number.NaN, outputTokens: -1 })).toBeUndefined();
  });

  test("a provider's whole-turn totals win over its context fields", () => {
    // Codex-like: the top level is the turn's last model call, input including cache reads.
    expect(
      toTurnUsage({
        inputTokens: 206_044,
        cachedInputTokens: 204_160,
        outputTokens: 1_372,
        turnTotals: { inputTokens: 31_000, cachedInputTokens: 2_400_000, outputTokens: 18_000 },
      }),
    ).toEqual({ inputTokens: 31_000, cachedInputTokens: 2_400_000, outputTokens: 18_000 });
    // Claude-like: tokens and the session's cost come as turn totals; the top level holds the
    // main loop's tokens and the running cost.
    expect(
      toTurnUsage({
        inputTokens: 8,
        cachedInputTokens: 174_852,
        outputTokens: 7_609,
        totalCostUsd: 1.2,
        turnTotals: {
          inputTokens: 21_000,
          cachedInputTokens: 180_000,
          outputTokens: 7_700,
          costUsd: 0.53,
        },
      }),
    ).toEqual({
      inputTokens: 21_000,
      cachedInputTokens: 180_000,
      outputTokens: 7_700,
      costUsd: 0.53,
    });
  });

  test("session totals count only their growth since the agent's previous turn", () => {
    const reading = {
      inputTokens: 999,
      sessionTotals: { inputTokens: 300, cachedInputTokens: 50, outputTokens: 40, costUsd: 0.3 },
    };
    expect(toTurnUsage(reading)).toEqual({
      inputTokens: 300,
      cachedInputTokens: 50,
      outputTokens: 40,
      costUsd: 0.3,
    });
    expect(
      toTurnUsage(reading, {
        inputTokens: 100,
        cachedInputTokens: 50,
        outputTokens: 10,
        costUsd: 0.1,
      }),
    ).toEqual({
      inputTokens: 200,
      cachedInputTokens: 0,
      outputTokens: 30,
      costUsd: expect.closeTo(0.2),
    });
    // A total below the baseline means the provider started counting again.
    expect(toTurnUsage(reading, { inputTokens: 5_000 })).toMatchObject({ inputTokens: 300 });
    // A field the totals lack falls back to the reading's own.
    expect(
      toTurnUsage({ outputTokens: 7, sessionTotals: { costUsd: 2 } }, { costUsd: 1.5 }),
    ).toEqual({ outputTokens: 7, costUsd: expect.closeTo(0.5) });
  });

  test("each turn of an agent is measured from where its previous turn ended", () => {
    const meter = createTurnUsageMeter();
    const reading = (sessionTotals: Record<string, number>) => ({ sessionTotals });
    expect(meter.measure("a1", reading({ inputTokens: 100, costUsd: 0.1 }))).toEqual({
      inputTokens: 100,
      costUsd: 0.1,
    });
    expect(meter.measure("a2", reading({ inputTokens: 40 }))).toEqual({ inputTokens: 40 });
    expect(meter.measure("a1", reading({ inputTokens: 250, costUsd: 0.25 }))).toEqual({
      inputTokens: 150,
      costUsd: expect.closeTo(0.15),
    });
    // A turn that reported nothing leaves the agent's baseline where it was.
    expect(meter.measure("a1", undefined)).toBeUndefined();
    expect(meter.measure("a1", reading({ inputTokens: 300, costUsd: 0.25 }))).toEqual({
      inputTokens: 50,
      costUsd: 0,
    });
  });
});

describe("workspace port", () => {
  function setup(waitForWorkspaceSetup: (id: string) => Promise<void> = async () => {}) {
    const worktreeCalls: Record<string, unknown>[] = [];
    const order: string[] = [];
    const deps = {
      logger: pino({ level: "silent" }),
      createDirectoryWorkspace: async () => ({ workspaceId: "dir-1", cwd: "/repo" }),
      createPaseoWorktreeWorkspace: async (input: Record<string, unknown>) => {
        worktreeCalls.push(input);
        order.push("created");
        return {
          workspace: { workspaceId: "wt-1", cwd: "/wt/1" },
          worktree: { worktreePath: "/nonexistent/wt/1" },
        };
      },
      archiveWorkspace: async () => {},
      waitForWorkspaceSetup: async (id: string) => {
        order.push("waiting");
        await waitForWorkspaceSetup(id);
        order.push("setup done");
      },
    } as unknown as GoalPortDeps;
    return { port: createGoalWorkspacePort(deps), worktreeCalls, order };
  }

  test("an ordinary worktree is offered to the branch auto-namer and waits for its setup", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { port, worktreeCalls, order } = setup(() => gate);

    const pending = port.create({
      cwd: "/repo",
      isolation: "worktree",
      title: "Task a",
      baseRef: "abc",
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(order).toEqual(["created", "waiting"]);
    release();

    expect(await pending).toEqual({ workspaceId: "wt-1", cwd: "/wt/1" });
    expect(worktreeCalls[0]).toMatchObject({
      firstAgentContext: { prompt: "Task a" },
      refName: "abc",
      action: "branch-off",
    });
  });

  test("a worktree whose branch name must stay is never offered to the auto-namer", async () => {
    const { port, worktreeCalls } = setup();
    await port.create({
      cwd: "/repo",
      isolation: "worktree",
      title: "Integration",
      branchName: "paseo-goal/g1",
      keepBranchName: true,
    });
    expect(worktreeCalls[0]).toMatchObject({ branchName: "paseo-goal/g1" });
    expect(worktreeCalls[0]).not.toHaveProperty("firstAgentContext");
  });
});

describe("agent port", () => {
  function setup(
    reported: { runtime?: string | null; config?: string } = {},
    modes: Record<string, string[]> = { claude: ["default", "auto", "bypassPermissions"] },
  ) {
    const calls: Record<string, unknown>[] = [];
    const deps = {
      logger: pino({ level: "silent" }),
      modeCatalog: async (provider: string) => {
        const ids = modes[provider];
        if (!ids) throw new Error(`no catalog for ${provider}`);
        return ids.map((id) => ({ id }));
      },
      createAgent: async (input: Record<string, unknown>) => {
        calls.push(input);
        return {
          snapshot: {
            id: "agent-1",
            config: { thinkingOptionId: reported.config ?? input.thinking },
            runtimeInfo:
              reported.runtime === undefined ? undefined : { thinkingOptionId: reported.runtime },
          },
        };
      },
    } as unknown as GoalPortDeps;
    return { port: createGoalAgentPort(deps), calls };
  }

  const base = { cwd: "/repo", workspaceId: "ws-1", title: "Lead", labels: {} };

  test("findAgents returns agents not archived that carry every label, with their workspace", async () => {
    const records = [
      {
        id: "a1",
        workspaceId: "ws-1",
        labels: { "paseo.goal-id": "g1", "paseo.goal-recovery": "r1" },
      },
      { id: "a2", labels: { "paseo.goal-id": "g1", "paseo.goal-recovery": "r1" } },
      {
        id: "a3",
        workspaceId: "ws-3",
        archivedAt: "2026-01-01T00:00:00.000Z",
        labels: { "paseo.goal-id": "g1", "paseo.goal-recovery": "r1" },
      },
      { id: "a4", workspaceId: "ws-4", labels: { "paseo.goal-id": "g1" } },
    ];
    const port = createGoalAgentPort({
      logger: pino({ level: "silent" }),
      agentStorage: { list: async () => records },
    } as unknown as GoalPortDeps);
    expect(await port.findAgents?.({ "paseo.goal-id": "g1", "paseo.goal-recovery": "r1" })).toEqual(
      [
        { agentId: "a1", workspaceId: "ws-1" },
        { agentId: "a2", workspaceId: null },
      ],
    );
  });

  test("a provider/model value starts the provider with that model", async () => {
    const { port, calls } = setup();
    await port.createAgent({ ...base, provider: "codex/some-model" });
    expect(calls[0]).toMatchObject({
      provider: "codex/some-model",
      config: { provider: "codex", model: "some-model", cwd: "/repo" },
    });
  });

  test("a bare provider id leaves the model to the provider default", async () => {
    const { port, calls } = setup();
    await port.createAgent({ ...base, provider: "claude" });
    expect(calls[0]).toMatchObject({ provider: "claude", config: { provider: "claude" } });
    expect(calls[0]?.config).not.toHaveProperty("model");
  });

  test("a thinking id is passed to the create path the way a chat's is", async () => {
    const { port, calls } = setup();
    const created = await port.createAgent({ ...base, provider: "codex", thinking: "high" });
    expect(calls[0]).toMatchObject({ thinking: "high" });
    expect(created).toEqual({ agentId: "agent-1", thinking: "high" });
  });

  test("without a thinking id nothing is passed, and the agent reports what it runs with", async () => {
    const { port, calls } = setup({ runtime: "medium" });
    const created = await port.createAgent({ ...base, provider: "codex" });
    expect(calls[0]).not.toHaveProperty("thinking");
    expect(created).toEqual({ agentId: "agent-1", thinking: "medium" });
    const silent = setup();
    expect(await silent.port.createAgent({ ...base, provider: "codex" })).toEqual({
      agentId: "agent-1",
    });
  });

  test("each permission policy picks how the agent starts", async () => {
    const { port, calls } = setup({}, { claude: ["default", "auto"], codex: ["read-only"] });
    // Absent is the policy of goals stored before policies were recorded.
    await port.createAgent({ ...base, provider: "claude" });
    await port.createAgent({ ...base, provider: "claude", permission: "fail" });
    await port.createAgent({ ...base, provider: "claude", permission: "wait" });
    await port.createAgent({ ...base, provider: "claude/opus", permission: "auto" });
    // A provider without an auto mode, or whose modes cannot be read, starts as under wait.
    await port.createAgent({ ...base, provider: "codex", permission: "auto" });
    await port.createAgent({ ...base, provider: "opencode", permission: "auto" });
    expect(calls.map((c) => ({ unattended: c.unattended, mode: c.mode }))).toEqual([
      { unattended: true, mode: undefined },
      { unattended: true, mode: undefined },
      { unattended: false, mode: undefined },
      { unattended: false, mode: "auto" },
      { unattended: false, mode: undefined },
      { unattended: false, mode: undefined },
    ]);
  });

  test("auto picks each provider's own auto mode from its real mode list", async () => {
    const codexModes = CODEX_MODE_IDS;
    const { port, calls } = setup(
      {},
      {
        claude: ["default", "acceptEdits", "plan", "auto", "bypassPermissions"],
        codex: codexModes,
        // A provider without a preference entry keeps the `auto` id rule.
        other: ["ask", "auto"],
        none: ["ask", "yolo"],
      },
    );
    for (const provider of ["claude", "codex/gpt-6-luna", "other", "none"]) {
      await port.createAgent({ ...base, provider, permission: "auto" });
    }
    // A Codex too old for the auto-reviewer: its `auto` is Default Permissions, so it is not used.
    const old = setup({}, { codex: codexModes.filter((id) => id !== "auto-review") });
    await old.port.createAgent({ ...base, provider: "codex", permission: "auto" });
    expect([...calls, ...old.calls].map((c) => c.mode)).toEqual([
      "auto",
      "auto-review",
      "auto",
      undefined,
      undefined,
    ]);
  });
});

/** The mode ids the Codex provider lists when its version supports the auto-reviewer. */
const CODEX_MODE_IDS = ["auto", "auto-review", "full-access"];

describe("goalPolicyModeId", () => {
  const catalogs: Record<string, GoalMode[]> = {
    claude: [{ id: "default" }, { id: "auto" }, { id: "bypassPermissions", isUnattended: true }],
    codex: [{ id: "auto" }, { id: "auto-review" }, { id: "full-access", isUnattended: true }],
    plain: [{ id: "build" }],
  };
  const defaults: Record<string, string> = {
    claude: "default",
    codex: "auto-review",
    plain: "build",
  };
  const deps = {
    modeCatalog: async (provider: string) => catalogs[provider] ?? [],
    defaultModeId: async (provider: string) => defaults[provider] ?? null,
  };
  const target = (provider: string, permission: "fail" | "wait" | "auto") =>
    goalPolicyModeId(deps, { provider, cwd: "/repo", permission });

  test("fail is the unattended mode, auto the auto mode, wait the default mode", async () => {
    expect(await target("claude", "fail")).toBe("bypassPermissions");
    expect(await target("claude", "auto")).toBe("auto");
    expect(await target("claude", "wait")).toBe("default");
    expect(await target("codex", "fail")).toBe("full-access");
    expect(await target("codex", "auto")).toBe("auto-review");
    expect(await target("codex", "wait")).toBe("auto-review");
  });

  test("auto without an auto mode is the default mode; fail without an unattended mode is none", async () => {
    expect(await target("plain", "auto")).toBe("build");
    // A Codex too old for the auto-reviewer starts in Default Permissions, its default.
    const old = await goalPolicyModeId(
      {
        modeCatalog: async () => [{ id: "auto" }, { id: "full-access", isUnattended: true }],
        defaultModeId: async () => "auto",
      },
      { provider: "codex", cwd: "/repo", permission: "auto" },
    );
    expect(old).toBe("auto");
    expect(await target("plain", "fail")).toBeUndefined();
  });
});

describe("agent port setPermissionMode", () => {
  function setup(notice: { type: string; message: string } | null) {
    const setModes: { agentId: string; modeId: string }[] = [];
    const agent = { id: "agent-1", provider: "codex", cwd: "/repo/ws" };
    const deps = {
      logger: pino({ level: "silent" }),
      modeCatalog: async () => [
        { id: "auto" },
        { id: "auto-review" },
        { id: "full-access", isUnattended: true },
      ],
      defaultModeId: async () => "auto-review",
      agentManager: {
        getAgent: (agentId: string) => (agentId === agent.id ? agent : null),
        setAgentMode: async (agentId: string, modeId: string) => {
          setModes.push({ agentId, modeId });
          return notice;
        },
      },
    } as unknown as GoalPortDeps;
    return { port: createGoalAgentPort(deps), setModes };
  }

  test("sets the policy's mode the way the mode picker does, and reports a next-turn switch", async () => {
    const midTurn = setup({ type: "warning", message: "Permission mode applies next turn" });
    expect(await midTurn.port.setPermissionMode("agent-1", "fail")).toEqual({
      modeId: "full-access",
      nextTurn: true,
    });
    expect(midTurn.setModes).toEqual([{ agentId: "agent-1", modeId: "full-access" }]);

    const idle = setup(null);
    expect(await idle.port.setPermissionMode("agent-1", "auto")).toEqual({
      modeId: "auto-review",
      nextTurn: false,
    });
  });
});

describe("watching ports", () => {
  const AT = "2026-01-01T00:00:00.000Z";
  const running = {
    type: "tool_call",
    callId: "c1",
    name: "Bash",
    status: "running",
    error: null,
    detail: { type: "shell", command: "npm test" },
  } as const;

  function timeline() {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("w1", { timestamp: AT });
    const agentManager = {
      fetchTimeline: (id: string, options?: AgentTimelineFetchOptions) => store.fetch(id, options),
      getTimeline: (id: string) => store.getItems(id),
    };
    return { store, agentManager };
  }

  test("the cursor grows with every raw row, even reasoning merged into one row", () => {
    const { store, agentManager } = timeline();
    store.append("w1", { type: "reasoning", text: "think" }, { timestamp: AT });
    const first = readTimelineCursor(agentManager, "w1");
    store.append("w1", { type: "reasoning", text: " more" }, { timestamp: AT });
    const second = readTimelineCursor(agentManager, "w1");
    expect(store.getItems("w1")).toHaveLength(1);
    expect(second?.nextSeq).toBe((first?.nextSeq ?? 0) + 1);
    expect(second?.lastTool).toBeUndefined();
  });

  const tool = (callId: string, status: "running" | "completed") =>
    ({ ...running, callId, name: callId === "a" ? "Bash" : "Read", status }) as const;
  const at = (minute: number) => `2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`;

  test("a tool updated while it runs is one running tool, and every update moves the cursor", () => {
    const { store, agentManager } = timeline();
    store.append("w1", tool("a", "running"), { timestamp: at(0), turnId: "t1" });
    const first = readTimelineCursor(agentManager, "w1");
    store.append("w1", tool("a", "running"), { timestamp: at(15), turnId: "t1" });
    const second = readTimelineCursor(agentManager, "w1");
    expect(store.getItems("w1")).toHaveLength(1);
    expect(second).toMatchObject({
      nextSeq: (first?.nextSeq ?? 0) + 1,
      runningTools: [{ callId: "a", name: "Bash" }],
    });
  });

  test("a tool still running behind a parallel one that finished is found", () => {
    const { store, agentManager } = timeline();
    store.append("w1", tool("a", "running"), { timestamp: at(0), turnId: "t1" });
    store.append("w1", tool("b", "running"), { timestamp: at(1), turnId: "t1" });
    store.append("w1", tool("b", "completed"), { timestamp: at(2), turnId: "t1" });
    expect(readTimelineCursor(agentManager, "w1")?.runningTools).toEqual([
      { callId: "a", name: "Bash" },
    ]);
    store.append("w1", tool("a", "completed"), { timestamp: at(3), turnId: "t1" });
    expect(readTimelineCursor(agentManager, "w1")?.runningTools).toEqual([]);
  });

  test("a tool left running by an earlier turn does not count; the last error does", () => {
    const { store, agentManager } = timeline();
    store.append("w1", tool("a", "running"), { timestamp: at(0), turnId: "t1" });
    store.append(
      "w1",
      { type: "error", message: "x".repeat(800) },
      { timestamp: at(1), turnId: "t2" },
    );
    store.append(
      "w1",
      { type: "assistant_message", text: "next" },
      { timestamp: at(2), turnId: "t2" },
    );
    const cursor = readTimelineCursor(agentManager, "w1");
    expect(cursor?.runningTools).toEqual([]);
    expect(cursor?.lastError).toHaveLength(500);
  });

  test("an agent that is not loaded has no cursor", () => {
    const { agentManager } = timeline();
    expect(readTimelineCursor(agentManager, "unknown")).toBeNull();
  });

  test("the activity digest keeps the newest text within its cap", () => {
    const { store, agentManager } = timeline();
    for (let i = 0; i < 40; i += 1) {
      store.append("w1", { type: "assistant_message", text: `message ${i} ${"x".repeat(200)}` });
    }
    const digest = readActivityDigest(agentManager, "w1", 3000);
    expect(digest.length).toBe(3000);
    expect(digest.startsWith("…")).toBe(true);
    expect(digest).toContain("message 39");
  });

  test("steer never replaces the turn and records the message with a client id", async () => {
    const calls: { agentId: string; prompt: unknown; clientMessageId?: string }[] = [];
    let status: "steered" | "inactive" | "unavailable" = "steered";
    const deps = {
      logger: pino({ level: "silent" }),
      agentManager: {
        steerActiveTurnOnly: async (
          agentId: string,
          prompt: unknown,
          options?: { clientMessageId?: string },
        ) => {
          calls.push({ agentId, prompt, clientMessageId: options?.clientMessageId });
          return { status };
        },
        hasInFlightRun: (agentId: string) => agentId === "busy",
      },
    } as unknown as GoalPortDeps;
    const port = createGoalAgentPort(deps);
    expect(await port.steer("w1", "hello")).toBe("steered");
    expect(calls[0]).toMatchObject({ agentId: "w1", prompt: "hello" });
    expect(calls[0]?.clientMessageId).toEqual(expect.any(String));
    status = "inactive";
    expect(await port.steer("w1", "hello")).toBe("unavailable");
    status = "unavailable";
    expect(await port.steer("w1", "hello")).toBe("unavailable");
    expect(await port.isBusy("busy")).toBe(true);
    expect(await port.isBusy("w1")).toBe(false);
  });
});
