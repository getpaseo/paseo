import { describe, expect, it, vi } from "vitest";
import { selectLiveAgentProviderModel } from "./continuation";

describe("live agent provider selection", () => {
  it("updates a model in place within the current provider", () => {
    const setCurrentModel = vi.fn(async () => undefined);
    const continueWithSetup = vi.fn();
    selectLiveAgentProviderModel({
      provider: "codex",
      modelId: "gpt-5.4",
      currentProvider: "codex",
      setCurrentModel,
      continueWithSetup,
    });
    expect(setCurrentModel).toHaveBeenCalledWith("gpt-5.4");
    expect(continueWithSetup).not.toHaveBeenCalled();
  });

  it("opens a clean continuation when changing provider", () => {
    const setCurrentModel = vi.fn(async () => undefined);
    const continueWithSetup = vi.fn();
    selectLiveAgentProviderModel({
      provider: "claude",
      modelId: "claude-opus-4",
      currentProvider: "codex",
      setCurrentModel,
      continueWithSetup,
    });
    expect(setCurrentModel).not.toHaveBeenCalled();
    expect(continueWithSetup).toHaveBeenCalledWith({
      provider: "claude",
      accountProfileId: undefined,
      model: "claude-opus-4",
      modeId: null,
      thinkingOptionId: null,
    });
  });
});
