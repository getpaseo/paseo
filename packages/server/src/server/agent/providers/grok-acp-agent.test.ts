import { describe, expect, test, vi } from "vitest";

import type { AgentSessionConfig, AgentTimelineItem } from "../agent-sdk-types.js";
import type { ACPExtMethodContext } from "./acp-agent.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import {
  GROK_AGENT_MODE_ID,
  GROK_PLAN_MODE_FEATURE_ID,
  GROK_PLAN_MODE_ID,
  GrokACPAgentClient,
  buildGrokPlanModeFeature,
  handleGrokExtMethod,
  mapGrokPlanPermissionResponse,
  parseGrokExitPlanModeRequest,
  syncGrokPlanModeFromCurrentMode,
  transformGrokModeId,
  writeGrokFeature,
} from "./grok-acp-agent.js";

function createExtMethodContext(
  overrides: Partial<ACPExtMethodContext> = {},
): ACPExtMethodContext & { timeline: AgentTimelineItem[] } {
  const timeline: AgentTimelineItem[] = [];
  const config: AgentSessionConfig = {
    provider: "acp",
    cwd: "/tmp/paseo-grok-test",
    featureValues: { [GROK_PLAN_MODE_FEATURE_ID]: true },
  };
  return {
    provider: "acp",
    sessionId: "sess-1",
    requestPermission: async () => ({ behavior: "allow", selectedActionId: "implement" }),
    ...overrides,
    config: overrides.config ?? config,
    emitTimeline:
      overrides.emitTimeline ??
      ((item) => {
        timeline.push(item);
      }),
    timeline,
  };
}

describe("Grok plan mode helpers", () => {
  test("parses camelCase exit_plan_mode params", () => {
    expect(
      parseGrokExitPlanModeRequest({
        sessionId: "sess-1",
        toolCallId: "tc-1",
        planContent: "# Plan",
      }),
    ).toEqual({
      sessionId: "sess-1",
      toolCallId: "tc-1",
      planContent: "# Plan",
    });
  });

  test("parses snake_case exit_plan_mode params", () => {
    expect(
      parseGrokExitPlanModeRequest({
        session_id: "sess-1",
        tool_call_id: "tc-1",
        plan_content: null,
      }),
    ).toEqual({
      sessionId: "sess-1",
      toolCallId: "tc-1",
      planContent: null,
    });
  });

  test("rejects exit_plan_mode params without session or tool identity", () => {
    expect(() => parseGrokExitPlanModeRequest({ planContent: "# Plan" })).toThrow(
      "Invalid exit_plan_mode params",
    );
  });

  test("maps implement to approved and dismiss to cancelled", () => {
    expect(
      mapGrokPlanPermissionResponse({ behavior: "allow", selectedActionId: "implement" }),
    ).toEqual({ outcome: "approved" });
    expect(
      mapGrokPlanPermissionResponse({ behavior: "deny", selectedActionId: "dismiss" }),
    ).toEqual({
      outcome: "cancelled",
    });
    expect(mapGrokPlanPermissionResponse({ behavior: "deny", interrupt: true })).toEqual({
      outcome: "cancelled",
    });
  });

  test("writeGrokFeature toggles session/set_mode between plan and agent", async () => {
    const setSessionMode = vi.fn().mockResolvedValue({});
    await expect(
      writeGrokFeature({
        connection: { setSessionMode } as never,
        sessionId: "sess-1",
        featureId: GROK_PLAN_MODE_FEATURE_ID,
        value: true,
      }),
    ).resolves.toBe(true);
    expect(setSessionMode).toHaveBeenCalledWith({
      sessionId: "sess-1",
      modeId: GROK_PLAN_MODE_ID,
    });

    await writeGrokFeature({
      connection: { setSessionMode } as never,
      sessionId: "sess-1",
      featureId: GROK_PLAN_MODE_FEATURE_ID,
      value: false,
    });
    expect(setSessionMode).toHaveBeenLastCalledWith({
      sessionId: "sess-1",
      modeId: GROK_AGENT_MODE_ID,
    });

    await expect(
      writeGrokFeature({
        connection: { setSessionMode } as never,
        sessionId: "sess-1",
        featureId: "auto_accept",
        value: true,
      }),
    ).resolves.toBe(false);
  });

  test("syncs plan_mode from Grok current_mode_update ids only", () => {
    const config: AgentSessionConfig = { provider: "acp", cwd: "/tmp" };
    syncGrokPlanModeFromCurrentMode(GROK_PLAN_MODE_ID, config);
    expect(config.featureValues).toEqual({ [GROK_PLAN_MODE_FEATURE_ID]: true });
    syncGrokPlanModeFromCurrentMode(GROK_AGENT_MODE_ID, config);
    expect(config.featureValues).toEqual({ [GROK_PLAN_MODE_FEATURE_ID]: false });
    syncGrokPlanModeFromCurrentMode("default", config);
    expect(config.featureValues).toEqual({ [GROK_PLAN_MODE_FEATURE_ID]: false });
  });

  test("hides Grok collaboration modes from the permission-mode picker", () => {
    expect(transformGrokModeId(GROK_PLAN_MODE_ID)).toBeNull();
    expect(transformGrokModeId(GROK_AGENT_MODE_ID)).toBeNull();
    expect(transformGrokModeId("default")).toBe("default");
  });
});

describe("GrokACPAgentClient", () => {
  test("lists plan_mode without probing a session", async () => {
    const client = new GrokACPAgentClient({
      logger: createTestLogger(),
      command: ["grok", "agent", "stdio"],
      providerId: "grok",
      label: "Grok",
    });

    await expect(
      client.listFeatures({
        provider: "acp",
        cwd: "/tmp/paseo-grok-test",
        featureValues: { [GROK_PLAN_MODE_FEATURE_ID]: true },
      }),
    ).resolves.toEqual([
      {
        type: "toggle",
        id: "auto_accept",
        label: "Auto Accept",
        description: "Automatically approves ACP permission prompts.",
        tooltip: "Auto accept permission prompts",
        icon: "shield-check",
        value: false,
      },
      buildGrokPlanModeFeature(true),
    ]);
  });
});

describe("Grok exit_plan_mode handling", () => {
  test("approves a plan and records it on the timeline", async () => {
    const context = createExtMethodContext();

    await expect(
      handleGrokExtMethod(
        "x.ai/exit_plan_mode",
        {
          sessionId: "sess-1",
          toolCallId: "tc-plan",
          planContent: "- add tests",
        },
        context,
      ),
    ).resolves.toEqual({ outcome: "approved" });

    expect(context.config.featureValues).toEqual({ [GROK_PLAN_MODE_FEATURE_ID]: false });
    expect(context.timeline).toEqual([
      {
        type: "tool_call",
        callId: "tc-plan",
        name: "plan",
        status: "completed",
        error: null,
        detail: { type: "plan", text: "- add tests" },
      },
    ]);
  });

  test("does not record a completed plan when the user dismisses approval", async () => {
    const context = createExtMethodContext({
      requestPermission: async () => ({ behavior: "deny", selectedActionId: "dismiss" }),
    });

    await expect(
      handleGrokExtMethod(
        "_x.ai/exit_plan_mode",
        {
          sessionId: "sess-1",
          toolCallId: "tc-plan",
          planContent: "- add tests",
        },
        context,
      ),
    ).resolves.toEqual({ outcome: "cancelled" });

    expect(context.config.featureValues).toEqual({ [GROK_PLAN_MODE_FEATURE_ID]: true });
    expect(context.timeline).toEqual([]);
  });

  test("rejects an exit_plan_mode request for a different session", async () => {
    const context = createExtMethodContext();

    await expect(
      handleGrokExtMethod(
        "x.ai/exit_plan_mode",
        {
          sessionId: "other-session",
          toolCallId: "tc-plan",
          planContent: "- add tests",
        },
        context,
      ),
    ).rejects.toThrow("exit_plan_mode sessionId does not match the active session");
    expect(context.timeline).toEqual([]);
  });

  test("ignores unrelated extension methods", async () => {
    await expect(
      handleGrokExtMethod(
        "x.ai/ask_user_question",
        { sessionId: "sess-1" },
        createExtMethodContext(),
      ),
    ).resolves.toBeNull();
  });
});
