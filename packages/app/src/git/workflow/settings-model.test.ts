import { describe, expect, it } from "vitest";
import {
  createWorkspaceGitWorkflowSettingsModel,
  workspaceGitWorkflowSettingsPatch,
  selectWorkspaceWorkflowModel,
} from "./settings-model";

describe("workspace git workflow settings model", () => {
  it("keeps blank fields editable and persists every configured value", () => {
    const model = createWorkspaceGitWorkflowSettingsModel({
      reviewProfileId: "review",
      createPrPrompt: "Create this PR\nwithout rewriting history.",
    });

    expect(model.deliveryProfileId).toBe("");
    expect(workspaceGitWorkflowSettingsPatch(model)).toEqual({
      reviewProfileId: "review",
      deliveryProfileId: "",
      reviewPrompt: "",
      createPrPrompt: "Create this PR\nwithout rewriting history.",
      commitAndPushPrompt: "",
      reviewModel: null,
      commitModel: null,
      prModel: null,
    });
  });

  it("persists independent choices and clears only the selected action", () => {
    const model = createWorkspaceGitWorkflowSettingsModel({
      reviewProfileId: "old-review",
      deliveryProfileId: "old-delivery",
      reviewModel: { provider: "codex", model: "review", thinkingOptionId: "high" },
      commitModel: { provider: "claude", model: "commit" },
      prModel: { provider: "codex", model: "pr", thinkingOptionId: "low" },
      reviewPrompt: "Keep this prompt exactly.\n",
    });
    const patch = workspaceGitWorkflowSettingsPatch({ ...model, commitModel: null });
    expect(patch).toEqual({
      ...model,
      commitModel: null,
    });
    expect(createWorkspaceGitWorkflowSettingsModel(patch)).toEqual(patch);
  });

  it("keeps a supported effort only within the same provider", () => {
    const previous = { provider: "codex", model: "old", thinkingOptionId: "high" };
    const model = {
      provider: "codex",
      id: "new",
      label: "New",
      thinkingOptions: [{ id: "high", label: "High" }],
    };
    expect(selectWorkspaceWorkflowModel(previous, "codex", "new", model)).toEqual({
      provider: "codex",
      model: "new",
      thinkingOptionId: "high",
    });
    expect(selectWorkspaceWorkflowModel(previous, "claude", "new", model)).toEqual({
      provider: "claude",
      model: "new",
    });
    expect(
      selectWorkspaceWorkflowModel(previous, "codex", "new", {
        provider: "codex",
        id: "new",
        label: "New",
      }),
    ).toEqual({
      provider: "codex",
      model: "new",
    });
    expect(selectWorkspaceWorkflowModel(null, "codex", "", null)).toEqual({ provider: "codex" });
  });
});
