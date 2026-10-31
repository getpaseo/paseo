import { describe, expect, it } from "vitest";
import { TURN_LIVENESS_IDLE } from "@/timeline/turn-liveness";
import { buildWorkspaceTabAgentDetails } from "./workspace-tab-agent-details";

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
        agent: { ...base.agent, runtimeInfo: undefined, turn: TURN_LIVENESS_IDLE },
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
          turn: { ...base.agent.turn, phase: "open", startedAt: null, turnId: null },
        },
      }),
    ).toBe("Codex · Runtime Model · High");
  });

  it("clamps clock skew to zero", () => {
    expect(buildWorkspaceTabAgentDetails({ ...base, now: 5_000 })).toBe(
      "Codex · Runtime Model · High · 0s",
    );
  });
});
