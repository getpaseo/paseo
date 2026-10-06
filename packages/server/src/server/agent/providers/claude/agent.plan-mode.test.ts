import { afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentSession } from "../../agent-sdk-types.js";
import { ClaudeAgentClient } from "./agent.js";
import {
  closePlanSessions,
  createPlanSession,
  permissionRequests,
  settledOutcome,
  toolCallOptions,
} from "./test-utils/plan-session.js";

afterEach(closePlanSessions);

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

  test("overlapping Plan and access changes keep the latest access choice", async () => {
    const { session, queries } = await createPlanSession({ modeId: "bypassPermissions" });
    await session.setFeature?.("plan_mode", true);

    const hold = queries[0]?.holdNextPermissionMode();
    const planOff = session.setFeature?.("plan_mode", false);
    const accessChange = session.setMode("default");
    hold?.release();
    await Promise.all([planOff, accessChange]);

    await expect(session.getCurrentMode()).resolves.toBe("default");
    expect(planFeatureValue(session)).toBe(false);
    expect(queries[0]?.permissionModes.at(-1)).toBe("default");
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
