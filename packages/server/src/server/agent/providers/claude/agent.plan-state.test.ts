import { afterEach, describe, expect, test } from "vitest";
import type { PermissionMode, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentSession, AgentSessionConfig, AgentStreamEvent } from "../../agent-sdk-types.js";
import { ClaudeAgentClient } from "./agent.js";
import {
  closePlanSessions,
  ANTHROPIC_API_ENV,
  BEDROCK_ENV,
  createFakeClaudeQuery,
  createPlanSession,
  letThePumpRun,
  permissionRequests,
  settledOutcome,
  toolCallOptions,
  trackPlanSession,
} from "./test-utils/plan-session.js";

afterEach(closePlanSessions);

describe("Claude Plan state from stored and legacy configs", () => {
  async function planState(session: AgentSession) {
    return {
      mode: await session.getCurrentMode(),
      plan: session.features?.find((feature) => feature.id === "plan_mode")?.value,
    };
  }

  test("an agent stored with the old plan mode id resumes planning in Claude's default mode", async () => {
    const { session, launches } = await createPlanSession(
      { modeId: "plan" },
      { env: ANTHROPIC_API_ENV },
    );
    await session.startTurn("continue planning");

    await expect(planState(session)).resolves.toEqual({ mode: "auto", plan: true });
    expect(launches[0]?.options.permissionMode).toBe("plan");
  });

  test("an old plan mode id resumes in Always Ask where Claude Code has no Auto mode", async () => {
    const { session } = await createPlanSession({ modeId: "plan" }, { env: BEDROCK_ENV });

    await expect(planState(session)).resolves.toEqual({ mode: "default", plan: true });
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
    const { session } = await createPlanSession(
      { modeId: "plan", featureValues: { plan_mode: false } },
      { env: ANTHROPIC_API_ENV },
    );

    await expect(planState(session)).resolves.toEqual({ mode: "auto", plan: false });
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
    trackPlanSession(resumed);

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
    trackPlanSession(imported.session);

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
