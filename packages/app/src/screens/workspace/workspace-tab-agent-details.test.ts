import { describe, expect, it } from "vitest";
import type { Agent } from "@/stores/session-store";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import { TURN_LIVENESS_IDLE } from "@/timeline/turn-liveness";
import {
  buildWorkspaceTabAgentDetails,
  selectWorkspaceTabAgents,
  workspaceTabAgentsEqual,
} from "./workspace-tab-agent-details";

const base: Parameters<typeof buildWorkspaceTabAgentDetails>[0] = {
  agent: {
    provider: "codex",
    model: "configured-model",
    thinkingOptionId: "medium",
    runtimeInfo: {
      provider: "codex",
      sessionId: "session",
      model: "runtime-model",
      thinkingOptionId: "high",
    },
    turn: {
      phase: "open",
      startedAt: new Date(10_000),
      turnId: "turn",
      cancellationRequestId: null,
    },
  },
  entries: [
    {
      provider: "codex",
      label: "Codex",
      models: [
        {
          provider: "codex",
          id: "runtime-model",
          label: "Runtime Model",
          thinkingOptions: [{ id: "high", label: "High" }],
        },
      ],
    },
  ],
  now: 85_000,
};

describe("workspace tab agent details", () => {
  it("shows provider, reported model and thinking, and the current turn duration", () => {
    expect(buildWorkspaceTabAgentDetails(base)).toBe("Codex · Runtime Model · High · 1m 15s");
  });

  it("shows configured values before runtime metadata arrives", () => {
    expect(
      buildWorkspaceTabAgentDetails({
        ...base,
        entries: undefined,
        agent: {
          ...base.agent,
          runtimeInfo: undefined,
          turn: TURN_LIVENESS_IDLE,
        },
      }),
    ).toBe("codex · configured-model · Medium");
  });

  it("does not invent model, thinking or duration for an idle agent", () => {
    expect(
      buildWorkspaceTabAgentDetails({
        ...base,
        agent: { provider: "codex", model: null, turn: TURN_LIVENESS_IDLE },
      }),
    ).toBe("Codex");
  });

  it("does not use agent age for a running turn whose start is unknown", () => {
    expect(
      buildWorkspaceTabAgentDetails({
        ...base,
        agent: {
          ...base.agent,
          turn: {
            phase: "open",
            startedAt: null,
            turnId: null,
            cancellationRequestId: null,
          },
        },
      }),
    ).toBe("Codex · Runtime Model · High");
  });

  it("clamps clock skew to zero", () => {
    expect(buildWorkspaceTabAgentDetails({ ...base, now: 5_000 })).toBe(
      "Codex · Runtime Model · High · 0s",
    );
  });

  it("selects only the switcher tabs' needed agent fields and ignores unrelated agent updates", () => {
    const tab: WorkspaceTabDescriptor = {
      key: "agent_tab-1",
      tabId: "agent_tab-1",
      kind: "agent",
      target: { kind: "agent", agentId: "agent-1" },
    };
    const makeAgent = (id: string, title: string): Agent =>
      ({
        id,
        cwd: "/repo",
        provider: "codex",
        model: "configured-model",
        thinkingOptionId: "medium",
        title,
        turn: TURN_LIVENESS_IDLE,
      }) as unknown as Agent;

    const firstSelection = selectWorkspaceTabAgents({
      agents: new Map([
        ["agent-1", makeAgent("agent-1", "First")],
        ["agent-2", makeAgent("agent-2", "Unrelated")],
      ]),
      tabs: [tab],
    });
    const afterUnrelatedChange = selectWorkspaceTabAgents({
      agents: new Map([
        ["agent-1", makeAgent("agent-1", "Renamed")],
        ["agent-2", makeAgent("agent-2", "Updated")],
        ["agent-3", makeAgent("agent-3", "New")],
      ]),
      tabs: [tab],
    });

    expect(workspaceTabAgentsEqual(firstSelection, afterUnrelatedChange)).toBe(true);
  });
});
