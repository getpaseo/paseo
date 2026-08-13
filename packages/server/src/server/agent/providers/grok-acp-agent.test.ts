import { describe, expect, test, vi } from "vitest";

import type { AgentPermissionResponse, AgentSessionConfig } from "../agent-sdk-types.js";
import { ACPAgentSession } from "./acp-agent.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import {
  GROK_AGENT_MODE_ID,
  GROK_PLAN_MODE_FEATURE,
  GROK_PLAN_MODE_FEATURE_ID,
  GROK_PLAN_MODE_ID,
  GrokACPAgentClient,
  buildGrokPlanModeFeature,
  buildGrokPlanPermissionRequest,
  buildGrokPlanTimelineItem,
  handleGrokExtMethod,
  mapGrokPlanPermissionResponse,
  normalizeGrokExtMethod,
  parseGrokExitPlanModeRequest,
  syncGrokPlanModeFromCurrentMode,
  transformGrokModeId,
  writeGrokFeature,
} from "./grok-acp-agent.js";

const GROK_CAPABILITIES = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

function createGrokSession(featureValues?: Record<string, unknown>): ACPAgentSession {
  return new ACPAgentSession(
    {
      provider: "acp",
      cwd: "/tmp/paseo-grok-test",
      featureValues,
    },
    {
      provider: "acp",
      logger: createTestLogger(),
      defaultCommand: ["grok", "agent", "stdio"],
      defaultModes: [],
      staticToggleFeatures: [GROK_PLAN_MODE_FEATURE],
      featureWriter: writeGrokFeature,
      extMethodHandler: handleGrokExtMethod,
      currentModeListener: syncGrokPlanModeFromCurrentMode,
      modeIdTransformer: transformGrokModeId,
      capabilities: GROK_CAPABILITIES,
    },
  );
}

describe("Grok plan mode helpers", () => {
  test("normalizes underscored extension methods", () => {
    expect(normalizeGrokExtMethod("_x.ai/exit_plan_mode")).toBe("x.ai/exit_plan_mode");
    expect(normalizeGrokExtMethod("x.ai/exit_plan_mode")).toBe("x.ai/exit_plan_mode");
  });

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

  test("builds a plan permission with implement and dismiss actions", () => {
    expect(
      buildGrokPlanPermissionRequest({ provider: "acp", planContent: "- step" }),
    ).toMatchObject({
      provider: "acp",
      name: "GrokPlanApproval",
      kind: "plan",
      title: "Plan",
      input: { plan: "- step" },
      detail: { type: "plan", text: "- step" },
      actions: [
        { id: "dismiss", behavior: "deny", intent: "dismiss" },
        { id: "implement", behavior: "allow", intent: "implement" },
      ],
    });
  });

  test("builds a completed plan timeline item only when the plan has text", () => {
    expect(buildGrokPlanTimelineItem({ toolCallId: "tc-1", planContent: "# Ship it" })).toEqual({
      type: "tool_call",
      callId: "tc-1",
      name: "plan",
      status: "completed",
      error: null,
      detail: { type: "plan", text: "# Ship it" },
    });
    expect(buildGrokPlanTimelineItem({ toolCallId: "tc-1", planContent: "  " })).toBeNull();
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

describe("Grok ACP session plan support", () => {
  test("exposes plan_mode from restored feature values", () => {
    const session = createGrokSession({ [GROK_PLAN_MODE_FEATURE_ID]: true });
    expect(session.features).toEqual(expect.arrayContaining([buildGrokPlanModeFeature(true)]));
  });

  test("approves an exit_plan_mode ext method through the plan permission card", async () => {
    const session = createGrokSession({ [GROK_PLAN_MODE_FEATURE_ID]: true });
    const events: unknown[] = [];
    session.subscribe((event) => {
      events.push(event);
    });
    Object.assign(session, { sessionId: "sess-1" });

    const extMethod = session.extMethod("x.ai/exit_plan_mode", {
      sessionId: "sess-1",
      toolCallId: "tc-plan",
      planContent: "- add tests",
    });

    const requested = events.find(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        "type" in event &&
        event.type === "permission_requested",
    ) as { request: { id: string } } | undefined;
    expect(requested?.request.id).toEqual(expect.any(String));

    const response: AgentPermissionResponse = {
      behavior: "allow",
      selectedActionId: "implement",
    };
    await session.respondToPermission(requested!.request.id, response);

    await expect(extMethod).resolves.toEqual({ outcome: "approved" });
    expect(session.features).toEqual(expect.arrayContaining([buildGrokPlanModeFeature(false)]));
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "timeline",
          item: expect.objectContaining({
            type: "tool_call",
            callId: "tc-plan",
            detail: { type: "plan", text: "- add tests" },
          }),
        }),
      ]),
    );
  });
});
