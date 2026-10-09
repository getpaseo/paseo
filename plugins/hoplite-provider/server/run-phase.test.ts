import { describe, expect, it } from "vitest";
import { runPhaseTransformer } from "./run-phase.js";

const context = { sessionId: "session-1" };

// Frames captured from `hoplite acp` 3.0.0.
function runPhase(phase: string | null, label: string | null) {
  return {
    method: "_hoplite/run_phase",
    params: {
      sessionId: "thr_c75d39f7d7624256af918eeee2f4941b",
      runId: "run_eb213b97bd3147afb2927fbc27f87180",
      phase,
      label,
      startedAt: phase === null ? null : "2026-10-04T17:51:46.311Z",
    },
  };
}

describe("runPhaseTransformer", () => {
  it("shows a provisioning phase as one running workspace item per run", () => {
    const update = runPhaseTransformer.notification?.(
      runPhase("fetching_repository", "Cloning repository"),
      context,
    );

    expect(update).toEqual({
      type: "timeline",
      item: {
        type: "tool_call",
        id: "hoplite-run-phase:run_eb213b97bd3147afb2927fbc27f87180",
        callId: "hoplite-run-phase:run_eb213b97bd3147afb2927fbc27f87180",
        name: "Hoplite workspace",
        detail: { type: "plain_text", label: "Cloning repository", icon: "wrench" },
        status: "running",
        error: null,
      },
    });
  });

  it("completes the same item when the run leaves provisioning", () => {
    const update = runPhaseTransformer.notification?.(runPhase(null, null), context);

    expect(update).toMatchObject({
      type: "timeline",
      item: {
        id: "hoplite-run-phase:run_eb213b97bd3147afb2927fbc27f87180",
        status: "completed",
        detail: { label: "Workspace ready" },
      },
    });
  });

  it("falls back to the phase name when Hoplite sends no label", () => {
    const update = runPhaseTransformer.notification?.(
      runPhase("configuring_workspace", null),
      context,
    );

    expect(update).toMatchObject({ item: { detail: { label: "configuring_workspace" } } });
  });

  it("ignores other vendor notifications and malformed phases", () => {
    expect(
      runPhaseTransformer.notification?.({ method: "_hoplite/other", params: {} }, context),
    ).toBeNull();
    expect(
      runPhaseTransformer.notification?.(
        { method: "_hoplite/run_phase", params: { phase: "x" } },
        context,
      ),
    ).toBeNull();
  });
});
