import { afterEach, describe, expect, test } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import {
  closePlanSessions,
  createPlanSession,
  letThePumpRun,
  settledOutcome,
  toolCallOptions,
} from "./test-utils/plan-session.js";

afterEach(closePlanSessions);

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

  test("a card from a turn whose Claude Code process died settles once", async () => {
    const harness = await createPlanSession({ modeId: "default" });
    await harness.session.setFeature?.("plan_mode", true);
    await harness.session.startTurn("plan");
    const callback = settledOutcome(
      harness.canUseTool()("mcp__qa__search_docs", { query: "x" }, toolCallOptions("tool-mcp")),
    );
    const [request] = harness.session.getPendingPermissions();
    if (!request) throw new Error("Expected a pending tool permission");

    harness.queries[0]?.end();
    await letThePumpRun();

    await expect(callback).resolves.toEqual({
      rejected: "Claude stream ended before terminal result",
    });
    // The manager rebuilds its cards from this list, so a dead request must not stay in it.
    expect(harness.session.getPendingPermissions()).toEqual([]);
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

  test("a request still waiting when the turn completes stays answerable", async () => {
    // A background subagent can still be waiting on its tool after Claude's main turn completes.
    const harness = await createPlanSession({ modeId: "default" });
    await harness.session.setFeature?.("plan_mode", true);
    await harness.session.startTurn("plan");
    const callback = harness.canUseTool()(
      "mcp__qa__search_docs",
      { query: "x" },
      toolCallOptions("tool-mcp"),
    );
    const outcome = settledOutcome(callback);
    const [request] = harness.session.getPendingPermissions();
    if (!request) throw new Error("Expected a pending tool permission");

    harness.queries[0]?.emit({
      type: "result",
      subtype: "success",
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: false,
      num_turns: 1,
      result: "Planned.",
      stop_reason: null,
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
      modelUsage: {},
      permission_denials: [],
      uuid: "00000000-0000-4000-8000-00000000000c",
      session_id: "22222222-2222-4222-8222-222222222222",
    } as unknown as SDKMessage);
    await letThePumpRun();

    expect(harness.events.map((event) => event.type)).toContain("turn_completed");
    await expect(outcome).resolves.toEqual({ settled: false });
    expect(harness.session.getPendingPermissions().map((pending) => pending.id)).toEqual([
      request.id,
    ]);
    await harness.session.respondToPermission(request.id, { behavior: "allow" });
    await expect(callback).resolves.toMatchObject({ behavior: "allow" });
    expect(resolutions(harness.events)).toEqual([
      expect.objectContaining({ requestId: request.id, resolution: { behavior: "allow" } }),
    ]);
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
