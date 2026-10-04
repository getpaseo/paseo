import { afterEach, describe, expect, test } from "vitest";
import type {
  CanUseTool,
  PermissionMode,
  PermissionResult,
  Query,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentSession, AgentSessionConfig, AgentStreamEvent } from "../../agent-sdk-types.js";
import { ClaudeAgentClient } from "./agent.js";
import type { ClaudeQueryInput } from "./query.js";

interface FakeClaudeQuery {
  query: Query;
  permissionModes: PermissionMode[];
  /** Makes the next setPermissionMode call fail the way a dead Claude process does. */
  failNextPermissionMode(message: string): void;
  emit(message: SDKMessage): void;
}

function createFakeClaudeQuery(): FakeClaudeQuery {
  const permissionModes: PermissionMode[] = [];
  let permissionModeFailure: string | null = null;
  const pending: SDKMessage[] = [];
  const waiters: Array<(result: IteratorResult<SDKMessage, void>) => void> = [];
  let ended = false;
  const finish = () => {
    ended = true;
    for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
  };
  const fake = {
    async setPermissionMode(mode: PermissionMode) {
      if (permissionModeFailure) {
        const message = permissionModeFailure;
        permissionModeFailure = null;
        throw new Error(message);
      }
      permissionModes.push(mode);
    },
    async applyFlagSettings() {},
    async setModel() {},
    async getContextUsage() {
      return undefined;
    },
    async supportedCommands() {
      return [];
    },
    async supportedModels() {
      return [];
    },
    async interrupt() {},
    close: finish,
    async return() {
      finish();
      return { value: undefined, done: true };
    },
    next(): Promise<IteratorResult<SDKMessage, void>> {
      const message = pending.shift();
      if (message) return Promise.resolve({ value: message, done: false });
      if (ended) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => waiters.push(resolve));
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return {
    query: fake as unknown as Query,
    permissionModes,
    failNextPermissionMode(message) {
      permissionModeFailure = message;
    },
    emit(message) {
      const waiter = waiters.shift();
      if (waiter) waiter({ value: message, done: false });
      else pending.push(message);
    },
  };
}

interface PlanSessionHarness {
  session: AgentSession;
  launches: ClaudeQueryInput[];
  queries: FakeClaudeQuery[];
  events: AgentStreamEvent[];
  canUseTool(): CanUseTool;
}

const sessions: AgentSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
});

async function createPlanSession(
  config: Partial<AgentSessionConfig> = {},
): Promise<PlanSessionHarness> {
  const launches: ClaudeQueryInput[] = [];
  const queries: FakeClaudeQuery[] = [];
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    resolveBinary: async () => "/test/claude/bin",
    queryFactory: (input) => {
      launches.push(input);
      const fake = createFakeClaudeQuery();
      queries.push(fake);
      return fake.query;
    },
  });
  const session = await client.createSession({ provider: "claude", cwd: process.cwd(), ...config });
  sessions.push(session);
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  return {
    session,
    launches,
    queries,
    events,
    canUseTool() {
      const callback = launches.at(-1)?.options.canUseTool;
      if (!callback) throw new Error("Expected the Claude query to receive canUseTool");
      return callback;
    },
  };
}

function toolCallOptions(toolUseID: string): Parameters<CanUseTool>[2] {
  return { signal: new AbortController().signal, toolUseID, requestId: `request-${toolUseID}` };
}

function permissionRequests(events: AgentStreamEvent[]) {
  return events.filter((event) => event.type === "permission_requested");
}

type CallbackOutcome =
  | { settled: true; result: PermissionResult | null }
  | { settled: false }
  | { rejected: string };

/** A callback that waits for a person never settles on its own; one Paseo answers settles at once. */
async function settledOutcome(
  callback: Promise<PermissionResult | null>,
): Promise<CallbackOutcome> {
  const settled = callback.then(
    (result): CallbackOutcome => ({ settled: true, result }),
    (error: unknown): CallbackOutcome => ({
      rejected: error instanceof Error ? error.message : String(error),
    }),
  );
  const stillWaiting = new Promise<CallbackOutcome>((resolve) =>
    setImmediate(() => resolve({ settled: false })),
  );
  return Promise.race([settled, stillWaiting]);
}

describe("Claude Plan keeps the selected access mode", () => {
  test("Bypass plus Plan runs an MCP tool without a permission request", async () => {
    const { session, events, canUseTool } = await createPlanSession({
      modeId: "bypassPermissions",
    });

    await session.setMode("plan");
    await session.startTurn("plan the docs change");
    const outcome = await settledOutcome(
      canUseTool()("mcp__qa__search_docs", { query: "plan-check" }, toolCallOptions("tool-mcp")),
    );

    expect(outcome).toEqual({
      settled: true,
      result: { behavior: "allow", updatedInput: { query: "plan-check" } },
    });
    expect(permissionRequests(events)).toEqual([]);
    expect(session.getPendingPermissions()).toEqual([]);
  });

  test("Always Ask plus Plan still asks before the same MCP tool runs", async () => {
    const { session, events, canUseTool } = await createPlanSession({ modeId: "default" });

    await session.setMode("plan");
    await session.startTurn("plan the docs change");
    const outcome = await settledOutcome(
      canUseTool()("mcp__qa__search_docs", { query: "plan-check" }, toolCallOptions("tool-mcp")),
    );

    expect(outcome).toEqual({ settled: false });
    expect(permissionRequests(events)).toEqual([
      expect.objectContaining({
        request: expect.objectContaining({ kind: "tool", name: "mcp__qa__search_docs" }),
      }),
    ]);
    expect(session.getPendingPermissions()).toHaveLength(1);
  });

  test("Bypass plus Plan still asks the user a malformed AskUserQuestion", async () => {
    const { session, events, canUseTool } = await createPlanSession({
      modeId: "bypassPermissions",
    });

    await session.setMode("plan");
    await session.startTurn("plan the docs change");
    const outcome = await settledOutcome(
      canUseTool()("AskUserQuestion", { question: "Which?" }, toolCallOptions("tool-ask")),
    );

    expect(outcome).toEqual({ settled: false });
    expect(permissionRequests(events)).toHaveLength(1);
  });

  test("Bypass plus Plan keeps questions and plan approval interactive", async () => {
    const { session, events, canUseTool } = await createPlanSession({
      modeId: "bypassPermissions",
    });

    await session.setMode("plan");
    await session.startTurn("plan the docs change");
    const question = await settledOutcome(
      canUseTool()(
        "AskUserQuestion",
        { questions: [{ question: "Which file?", header: "File", options: [] }] },
        toolCallOptions("tool-question"),
      ),
    );
    const plan = await settledOutcome(
      canUseTool()("ExitPlanMode", { plan: "Edit README.md" }, toolCallOptions("tool-plan")),
    );

    expect(question).toEqual({ settled: false });
    expect(plan).toEqual({ settled: false });
    expect(permissionRequests(events).map((event) => event.request.kind)).toEqual([
      "question",
      "plan",
    ]);
  });

  test("Bypass plus Plan denies tools from a turn a human steer superseded", async () => {
    const { session, canUseTool } = await createPlanSession({ modeId: "bypassPermissions" });

    await session.setMode("plan");
    const { turnId } = await session.startTurn("plan the docs change");
    await expect(
      session.steerActiveTurn?.("plan something else instead", {
        expectedTurnId: turnId,
        clearPendingPermissions: true,
      }),
    ).resolves.toEqual({ status: "accepted" });
    const outcome = await settledOutcome(
      canUseTool()("mcp__qa__search_docs", { query: "plan-check" }, toolCallOptions("tool-mcp")),
    );

    expect(outcome).toEqual({
      settled: true,
      result: expect.objectContaining({
        behavior: "deny",
        message: expect.stringContaining("message instead of approving"),
      }),
    });
  });

  test("Bypass plus Plan does not approve a callback the SDK already aborted", async () => {
    const { session, canUseTool } = await createPlanSession({ modeId: "bypassPermissions" });

    await session.setMode("plan");
    await session.startTurn("plan the docs change");
    const abort = new AbortController();
    abort.abort();
    const outcome = await settledOutcome(
      canUseTool()(
        "mcp__qa__search_docs",
        { query: "plan-check" },
        { ...toolCallOptions("tool-mcp"), signal: abort.signal },
      ),
    );

    expect(outcome).toEqual({ rejected: "Permission request aborted" });
  });

  test("Bypass plus Plan asks when a permissions.ask rule forced the prompt", async () => {
    const { session, events, canUseTool } = await createPlanSession({
      modeId: "bypassPermissions",
    });

    await session.setMode("plan");
    await session.startTurn("plan the docs change");
    const outcome = await settledOutcome(
      canUseTool()(
        "Bash",
        { command: "git push" },
        {
          ...toolCallOptions("tool-bash"),
          matchedAskRule: { source: "userSettings", toolName: "Bash", ruleContent: "git push:*" },
        },
      ),
    );

    expect(outcome).toEqual({ settled: false });
    expect(permissionRequests(events)).toHaveLength(1);
  });
});

describe("Claude Plan is a feature beside the access mode", () => {
  function planFeatureValue(session: AgentSession): unknown {
    return session.features?.find((feature) => feature.id === "plan_mode")?.value;
  }

  test("turning Plan on keeps Bypass as the agent's mode", async () => {
    const { session, queries } = await createPlanSession({ modeId: "bypassPermissions" });

    await session.setFeature?.("plan_mode", true);

    await expect(session.getCurrentMode()).resolves.toBe("bypassPermissions");
    await expect(session.getRuntimeInfo()).resolves.toMatchObject({ modeId: "bypassPermissions" });
    expect(planFeatureValue(session)).toBe(true);
    expect(queries[0]?.permissionModes).toEqual(["plan"]);
  });

  test("turning Plan off hands Claude Code back the Bypass it kept", async () => {
    const { session, queries } = await createPlanSession({ modeId: "bypassPermissions" });

    await session.setFeature?.("plan_mode", true);
    await session.setFeature?.("plan_mode", false);

    await expect(session.getCurrentMode()).resolves.toBe("bypassPermissions");
    expect(planFeatureValue(session)).toBe(false);
    expect(queries[0]?.permissionModes).toEqual(["plan", "bypassPermissions"]);
  });

  test("choosing another access mode while planning keeps Plan on", async () => {
    const { session, queries, events, canUseTool } = await createPlanSession({
      modeId: "bypassPermissions",
    });

    await session.setFeature?.("plan_mode", true);
    await session.setMode("default");
    await session.startTurn("plan the docs change");
    const outcome = await settledOutcome(
      canUseTool()("mcp__qa__search_docs", { query: "plan-check" }, toolCallOptions("tool-mcp")),
    );

    await expect(session.getCurrentMode()).resolves.toBe("default");
    expect(planFeatureValue(session)).toBe(true);
    expect(queries[0]?.permissionModes).toEqual(["plan"]);
    expect(outcome).toEqual({ settled: false });
    expect(permissionRequests(events)).toHaveLength(1);
  });

  test("lists Plan for every Claude model, beside Fast where the model has it", async () => {
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      resolveBinary: async () => "/test/claude/bin",
    });

    const features = await client.listFeatures({
      provider: "claude",
      cwd: process.cwd(),
      model: "claude-sonnet-5",
      modeId: "bypassPermissions",
      featureValues: { plan_mode: true },
    });

    expect(features).toEqual([
      expect.objectContaining({ id: "plan_mode", type: "toggle", value: true }),
    ]);
  });
});

describe("Claude plan approval and query restarts", () => {
  async function requestPlanApproval(harness: PlanSessionHarness) {
    const callback = harness.canUseTool()(
      "ExitPlanMode",
      { plan: "Edit README.md" },
      toolCallOptions("tool-plan"),
    );
    const [request] = harness.session.getPendingPermissions();
    if (!request) throw new Error("Expected a pending plan approval");
    return { callback, request };
  }

  async function planningSession(modeId: string): Promise<PlanSessionHarness> {
    const harness = await createPlanSession({ modeId });
    await harness.session.setFeature?.("plan_mode", true);
    await harness.session.startTurn("plan the docs change");
    return harness;
  }

  test("Implement leaves Plan and continues in Accept File Edits", async () => {
    const harness = await planningSession("bypassPermissions");
    const { callback, request } = await requestPlanApproval(harness);

    await harness.session.respondToPermission(request.id, {
      behavior: "allow",
      selectedActionId: "implement",
    });

    await expect(callback).resolves.toMatchObject({ behavior: "allow" });
    await expect(harness.session.getCurrentMode()).resolves.toBe("acceptEdits");
    expect(harness.session.features).toContainEqual(
      expect.objectContaining({ id: "plan_mode", value: false }),
    );
    // The manager stores this, so a reload does not bring Plan back.
    expect(harness.session.featureValues).toEqual({ plan_mode: false });
    expect(harness.queries[0]?.permissionModes).toEqual(["plan", "acceptEdits"]);
  });

  test("Implement with Bypass leaves Plan and returns to Bypass", async () => {
    const harness = await planningSession("bypassPermissions");
    const { callback, request } = await requestPlanApproval(harness);

    expect(request.actions?.map((action) => action.id)).toEqual([
      "reject",
      "implement",
      "implement_resume",
    ]);
    await harness.session.respondToPermission(request.id, {
      behavior: "allow",
      selectedActionId: "implement_resume",
    });

    await expect(callback).resolves.toMatchObject({ behavior: "allow" });
    await expect(harness.session.getCurrentMode()).resolves.toBe("bypassPermissions");
    expect(harness.queries[0]?.permissionModes).toEqual(["plan", "bypassPermissions"]);
  });

  test("rejecting a plan keeps planning and keeps the access mode", async () => {
    const harness = await planningSession("bypassPermissions");
    const { callback, request } = await requestPlanApproval(harness);

    await harness.session.respondToPermission(request.id, {
      behavior: "deny",
      selectedActionId: "reject",
      message: "Not yet",
    });

    await expect(callback).resolves.toMatchObject({ behavior: "deny" });
    await expect(harness.session.getCurrentMode()).resolves.toBe("bypassPermissions");
    expect(harness.session.features).toContainEqual(
      expect.objectContaining({ id: "plan_mode", value: true }),
    );
    expect(harness.queries[0]?.permissionModes).toEqual(["plan"]);
  });

  test("Always Ask plus Plan offers no Implement with Bypass", async () => {
    const harness = await planningSession("default");
    const { callback, request } = await requestPlanApproval(harness);

    expect(request.actions?.map((action) => action.id)).toEqual(["reject", "implement"]);
    await harness.session.respondToPermission(request.id, { behavior: "deny" });
    await expect(callback).resolves.toMatchObject({ behavior: "deny" });
  });

  test("a recreated query starts in plan while Bypass stays the access mode", async () => {
    const harness = await createPlanSession({ modeId: "bypassPermissions" });
    await harness.session.setFeature?.("plan_mode", true);
    await harness.session.startTurn("first turn");
    await harness.session.interrupt();

    await harness.session.setThinkingOption?.("high");
    await harness.session.startTurn("second turn");
    const outcome = await settledOutcome(
      harness.canUseTool()("mcp__qa__search_docs", { query: "x" }, toolCallOptions("tool-mcp")),
    );

    expect(harness.launches).toHaveLength(2);
    expect(harness.launches[1]?.options.permissionMode).toBe("plan");
    await expect(harness.session.getCurrentMode()).resolves.toBe("bypassPermissions");
    expect(outcome).toEqual({
      settled: true,
      result: expect.objectContaining({ behavior: "allow" }),
    });
  });
});

describe("Claude Plan state from stored and legacy configs", () => {
  async function planState(session: AgentSession) {
    return {
      mode: await session.getCurrentMode(),
      plan: session.features?.find((feature) => feature.id === "plan_mode")?.value,
    };
  }

  test("an agent stored with the old plan mode id resumes planning in Always Ask", async () => {
    const { session, launches } = await createPlanSession({ modeId: "plan" });
    await session.startTurn("continue planning");

    await expect(planState(session)).resolves.toEqual({ mode: "default", plan: true });
    expect(launches[0]?.options.permissionMode).toBe("plan");
  });

  test("a stored Plan flag beside Bypass resumes Bypass plus Plan", async () => {
    const { session, launches, events, canUseTool } = await createPlanSession({
      modeId: "bypassPermissions",
      featureValues: { plan_mode: true },
    });
    await session.startTurn("continue planning");
    const outcome = await settledOutcome(
      canUseTool()("mcp__qa__search_docs", { query: "x" }, toolCallOptions("tool-mcp")),
    );

    await expect(planState(session)).resolves.toEqual({ mode: "bypassPermissions", plan: true });
    expect(launches[0]?.options.permissionMode).toBe("plan");
    expect(outcome).toEqual({
      settled: true,
      result: expect.objectContaining({ behavior: "allow" }),
    });
    expect(permissionRequests(events)).toEqual([]);
  });

  test("an explicit Plan off outranks the old plan mode id", async () => {
    const { session } = await createPlanSession({
      modeId: "plan",
      featureValues: { plan_mode: false },
    });

    await expect(planState(session)).resolves.toEqual({ mode: "default", plan: false });
  });

  test("resuming a session applies the stored access mode and Plan flag", async () => {
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      resolveBinary: async () => "/test/claude/bin",
      queryFactory: () => createFakeClaudeQuery().query,
    });
    const resumed = await client.resumeSession(
      {
        provider: "claude",
        sessionId: "00000000-0000-4000-8000-000000000001",
        metadata: { provider: "claude", cwd: process.cwd(), modeId: "plan" },
      },
      { modeId: "bypassPermissions", featureValues: { plan_mode: true } },
    );
    sessions.push(resumed);

    await expect(planState(resumed)).resolves.toEqual({ mode: "bypassPermissions", plan: true });
  });

  test("importing a Claude session keeps the access mode and Plan flag it is given", async () => {
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      resolveBinary: async () => "/test/claude/bin",
      queryFactory: () => createFakeClaudeQuery().query,
    });
    const config: AgentSessionConfig = {
      provider: "claude",
      cwd: process.cwd(),
      modeId: "bypassPermissions",
      featureValues: { plan_mode: true },
    };
    const imported = await client.importSession(
      { providerHandleId: "00000000-0000-4000-8000-000000000002", cwd: process.cwd() },
      { config, storedConfig: config },
    );
    sessions.push(imported.session);

    await expect(planState(imported.session)).resolves.toEqual({
      mode: "bypassPermissions",
      plan: true,
    });
    expect(imported.config).toMatchObject({
      modeId: "bypassPermissions",
      featureValues: { plan_mode: true },
    });
  });
});

describe("Claude Plan follows what Claude Code reports", () => {
  const SESSION_ID = "11111111-1111-4111-8111-111111111111";

  function statusMessage(permissionMode: PermissionMode): SDKMessage {
    return {
      type: "system",
      subtype: "status",
      status: null,
      permissionMode,
      uuid: "00000000-0000-4000-8000-00000000000a",
      session_id: SESSION_ID,
    } as SDKMessage;
  }

  function initMessage(permissionMode: PermissionMode): SDKMessage {
    return {
      type: "system",
      subtype: "init",
      permissionMode,
      session_id: SESSION_ID,
      uuid: "00000000-0000-4000-8000-00000000000b",
      model: "claude-sonnet-5",
      cwd: process.cwd(),
      tools: [],
      mcp_servers: [],
      slash_commands: [],
      apiKeySource: "none",
      output_style: "default",
      skills: [],
      plugins: [],
    } as unknown as SDKMessage;
  }

  async function letThePumpRun(): Promise<void> {
    for (let tick = 0; tick < 10; tick += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  function modeChanges(events: AgentStreamEvent[]) {
    return events.filter((event) => event.type === "mode_changed");
  }

  test("Claude entering plan mode itself turns Plan on and keeps Bypass", async () => {
    const harness = await createPlanSession({ modeId: "bypassPermissions" });
    await harness.session.startTurn("enter plan mode");

    harness.queries[0]?.emit(statusMessage("plan"));
    await letThePumpRun();
    const outcome = await settledOutcome(
      harness.canUseTool()("mcp__qa__search_docs", { query: "x" }, toolCallOptions("tool-mcp")),
    );

    await expect(harness.session.getCurrentMode()).resolves.toBe("bypassPermissions");
    expect(harness.session.features).toContainEqual(
      expect.objectContaining({ id: "plan_mode", value: true }),
    );
    expect(modeChanges(harness.events)).toEqual([
      expect.objectContaining({ currentModeId: "bypassPermissions" }),
    ]);
    expect(outcome).toEqual({
      settled: true,
      result: expect.objectContaining({ behavior: "allow" }),
    });
  });

  test("Claude leaving plan mode itself turns Plan off in the mode it reports", async () => {
    const harness = await createPlanSession({ modeId: "bypassPermissions" });
    await harness.session.setFeature?.("plan_mode", true);
    await harness.session.startTurn("plan");

    harness.queries[0]?.emit(statusMessage("acceptEdits"));
    await letThePumpRun();

    await expect(harness.session.getCurrentMode()).resolves.toBe("acceptEdits");
    expect(harness.session.features).toContainEqual(
      expect.objectContaining({ id: "plan_mode", value: false }),
    );
    expect(modeChanges(harness.events)).toEqual([
      expect.objectContaining({ currentModeId: "acceptEdits" }),
    ]);
  });

  test("an init that repeats the mode Paseo set changes nothing", async () => {
    const harness = await createPlanSession({ modeId: "bypassPermissions" });
    await harness.session.setFeature?.("plan_mode", true);
    await harness.session.startTurn("plan");

    harness.queries[0]?.emit(initMessage("plan"));
    await letThePumpRun();

    await expect(harness.session.getCurrentMode()).resolves.toBe("bypassPermissions");
    expect(harness.session.features).toContainEqual(
      expect.objectContaining({ id: "plan_mode", value: true }),
    );
    expect(modeChanges(harness.events)).toEqual([]);
  });
});

describe("Claude permission cards on the Plan path settle exactly once", () => {
  function resolutions(events: AgentStreamEvent[]) {
    return events.filter((event) => event.type === "permission_resolved");
  }

  test("a plan approval whose mode change fails stays answerable", async () => {
    const harness = await createPlanSession({ modeId: "bypassPermissions" });
    await harness.session.setFeature?.("plan_mode", true);
    await harness.session.startTurn("plan");
    const callback = settledOutcome(
      harness.canUseTool()(
        "ExitPlanMode",
        { plan: "Edit README.md" },
        toolCallOptions("tool-plan"),
      ),
    );
    const [request] = harness.session.getPendingPermissions();
    if (!request) throw new Error("Expected a pending plan approval");

    harness.queries[0]?.failNextPermissionMode("Claude Code process exited");
    await expect(
      harness.session.respondToPermission(request.id, {
        behavior: "allow",
        selectedActionId: "implement",
      }),
    ).rejects.toThrow("Claude Code process exited");

    expect(harness.session.getPendingPermissions().map((pending) => pending.id)).toEqual([
      request.id,
    ]);
    expect(resolutions(harness.events)).toEqual([]);
    await expect(harness.session.getCurrentMode()).resolves.toBe("bypassPermissions");

    await harness.session.respondToPermission(request.id, {
      behavior: "allow",
      selectedActionId: "implement",
    });
    await expect(callback).resolves.toEqual({
      settled: true,
      result: expect.objectContaining({ behavior: "allow" }),
    });
    expect(resolutions(harness.events)).toHaveLength(1);
  });

  test("choosing Bypass while planning answers the tool card that was already showing", async () => {
    const harness = await createPlanSession({ modeId: "default" });
    await harness.session.setFeature?.("plan_mode", true);
    await harness.session.startTurn("plan");
    const tool = settledOutcome(
      harness.canUseTool()("mcp__qa__search_docs", { query: "x" }, toolCallOptions("tool-mcp")),
    );
    const question = settledOutcome(
      harness.canUseTool()(
        "AskUserQuestion",
        { questions: [{ question: "Which file?", header: "File", options: [] }] },
        toolCallOptions("tool-question"),
      ),
    );
    const [toolRequest, questionRequest] = harness.session.getPendingPermissions();

    await harness.session.setMode("bypassPermissions");

    await expect(tool).resolves.toEqual({
      settled: true,
      result: { behavior: "allow", updatedInput: { query: "x" } },
    });
    await expect(question).resolves.toEqual({ settled: false });
    expect(resolutions(harness.events)).toEqual([
      expect.objectContaining({ requestId: toolRequest?.id, resolution: { behavior: "allow" } }),
    ]);
    expect(harness.session.getPendingPermissions().map((pending) => pending.id)).toEqual([
      questionRequest?.id,
    ]);
  });

  test("a late answer to a card the mode change settled is accepted once", async () => {
    const harness = await createPlanSession({ modeId: "default" });
    await harness.session.setFeature?.("plan_mode", true);
    await harness.session.startTurn("plan");
    void settledOutcome(
      harness.canUseTool()("mcp__qa__search_docs", { query: "x" }, toolCallOptions("tool-mcp")),
    );
    const [request] = harness.session.getPendingPermissions();
    if (!request) throw new Error("Expected a pending tool permission");

    await harness.session.setMode("bypassPermissions");
    await expect(
      harness.session.respondToPermission(request.id, { behavior: "allow" }),
    ).resolves.toBeUndefined();

    expect(resolutions(harness.events)).toHaveLength(1);
  });

  test("a late answer after Claude Code aborted the callback is accepted once", async () => {
    const harness = await createPlanSession({ modeId: "default" });
    await harness.session.setFeature?.("plan_mode", true);
    await harness.session.startTurn("plan");
    const abort = new AbortController();
    const callback = settledOutcome(
      harness.canUseTool()(
        "mcp__qa__search_docs",
        { query: "x" },
        { ...toolCallOptions("tool-mcp"), signal: abort.signal },
      ),
    );
    const [request] = harness.session.getPendingPermissions();
    if (!request) throw new Error("Expected a pending tool permission");

    abort.abort();
    await expect(callback).resolves.toEqual({ rejected: "Permission request aborted" });
    await expect(
      harness.session.respondToPermission(request.id, { behavior: "allow" }),
    ).resolves.toBeUndefined();

    expect(resolutions(harness.events)).toHaveLength(1);
  });

  test("a late answer after the user interrupted the turn is accepted once", async () => {
    const harness = await createPlanSession({ modeId: "default" });
    await harness.session.setFeature?.("plan_mode", true);
    await harness.session.startTurn("plan");
    const callback = settledOutcome(
      harness.canUseTool()("mcp__qa__search_docs", { query: "x" }, toolCallOptions("tool-mcp")),
    );
    const [request] = harness.session.getPendingPermissions();
    if (!request) throw new Error("Expected a pending tool permission");

    await harness.session.interrupt();
    await expect(callback).resolves.toEqual({ rejected: "Permission request canceled" });
    await expect(
      harness.session.respondToPermission(request.id, { behavior: "allow" }),
    ).resolves.toBeUndefined();

    expect(resolutions(harness.events)).toEqual([
      expect.objectContaining({
        requestId: request.id,
        resolution: expect.objectContaining({ behavior: "deny" }),
      }),
    ]);
  });
});
