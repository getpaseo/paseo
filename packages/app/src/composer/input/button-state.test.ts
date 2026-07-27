import { describe, expect, it, vi } from "vitest";
import { resolveComposerPrimaryButtonState, runComposerPrimaryButtonAction } from "./button-state";

const baseInput = {
  disabled: false,
  isSubmitDisabled: false,
  isSubmitLoading: false,
  canSubmitContent: false,
  isAgentRunning: false,
  canStop: false,
  canQueue: false,
};

describe("resolveComposerPrimaryButtonState", () => {
  it("shows stop while an agent runs and the composer is empty", () => {
    expect(
      resolveComposerPrimaryButtonState({
        ...baseInput,
        isAgentRunning: true,
        canStop: true,
        canQueue: true,
      }),
    ).toEqual({ mode: "stop", disabled: false });
  });

  it("switches the running button to queue when content is entered", () => {
    expect(
      resolveComposerPrimaryButtonState({
        ...baseInput,
        canSubmitContent: true,
        isAgentRunning: true,
        canStop: true,
        canQueue: true,
      }),
    ).toEqual({ mode: "queue", disabled: false });
  });

  it("sends normally while the agent is idle", () => {
    expect(resolveComposerPrimaryButtonState({ ...baseInput, canSubmitContent: true })).toEqual({
      mode: "send",
      disabled: false,
    });
  });

  it("disables queue while a transient submit operation is busy", () => {
    expect(
      resolveComposerPrimaryButtonState({
        ...baseInput,
        canSubmitContent: true,
        isAgentRunning: true,
        canStop: true,
        canQueue: true,
        isSubmitDisabled: true,
      }),
    ).toEqual({ mode: "queue", disabled: true });
  });
});

describe("runComposerPrimaryButtonAction", () => {
  it.each(["stop", "queue", "send"] as const)("runs only the %s action", (mode) => {
    const actions = { stop: vi.fn(), queue: vi.fn(), send: vi.fn() };
    runComposerPrimaryButtonAction(mode, actions);
    expect(actions[mode]).toHaveBeenCalledOnce();
    expect(Object.values(actions).filter((action) => action.mock.calls.length > 0)).toHaveLength(1);
  });
});
