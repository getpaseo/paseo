import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { describe, expect, it } from "vitest";
import {
  buildFeatureRequestKey,
  openAgentProfileForm,
  type AgentProfileFormModel,
} from "./profile-form-model";

const CLAUDE: ProviderSnapshotEntry = {
  provider: "claude",
  status: "ready",
  enabled: true,
  label: "Claude Code",
  defaultModeId: "plan",
  modes: [
    { id: "plan", label: "Plan" },
    { id: "accept-edits", label: "Accept edits" },
  ],
  models: [
    {
      provider: "claude",
      id: "claude-opus-5",
      label: "Opus 5",
      isDefault: true,
      thinkingOptions: [
        { id: "think", label: "Think" },
        { id: "think-hard", label: "Think hard" },
      ],
    },
    {
      provider: "claude",
      id: "claude-haiku-4-5",
      label: "Haiku 4.5",
      thinkingOptions: [{ id: "think", label: "Think" }],
    },
  ],
};

const CODEX: ProviderSnapshotEntry = {
  provider: "codex",
  status: "ready",
  enabled: true,
  label: "Codex",
  modes: [{ id: "read-only", label: "Read only" }],
  models: [{ provider: "codex", id: "gpt-5.2-codex", label: "GPT-5.2 Codex", isDefault: true }],
};

const DISABLED: ProviderSnapshotEntry = {
  provider: "pi",
  status: "ready",
  enabled: false,
  label: "Pi",
};

const ENTRIES = [CLAUDE, CODEX, DISABLED];

function openWithCatalog(
  snapshot: Parameters<typeof openAgentProfileForm>[0],
): AgentProfileFormModel {
  const model = openAgentProfileForm(snapshot);
  model.applyProviderCatalog(ENTRIES);
  return model;
}

function selectClaude(model: AgentProfileFormModel): void {
  model.setProvider("claude", { label: "Claude Code" });
}

function optionValues(options: readonly { value: string }[]): string[] {
  return options.map((option) => option.value);
}

describe("openAgentProfileForm", () => {
  it("starts a create form empty and cannot submit", () => {
    const model = openWithCatalog({ mode: "create" });
    const state = model.getState();

    expect(state.name).toBe("");
    expect(state.provider).toBe("");
    expect(state.canSubmit).toBe(false);
    expect(state.submitValue).toBeNull();
    expect(state.disclosure.showModelField).toBe(false);
  });

  it("lists only enabled providers", () => {
    const model = openWithCatalog({ mode: "create" });

    expect(optionValues(model.getState().providerOptions)).toEqual(["claude", "codex"]);
  });

  it("requires a name and a provider before it can submit", () => {
    const model = openWithCatalog({ mode: "create" });

    model.setName("UI work");
    expect(model.getState().canSubmit).toBe(false);

    selectClaude(model);
    expect(model.getState().canSubmit).toBe(true);
    expect(model.getState().submitValue).toMatchObject({ name: "UI work", provider: "claude" });
  });

  it("omits empty optional fields from the submitted value", () => {
    const model = openWithCatalog({ mode: "create" });
    model.setName("  Cheap grunt  ");
    model.setProvider("codex", { label: "Codex" });
    model.setNotes("   ");

    expect(model.getState().submitValue).toEqual({ name: "Cheap grunt", provider: "codex" });
  });

  it("seeds edit mode from the stored profile before the catalog lands", () => {
    const model = openAgentProfileForm({
      mode: "edit",
      profile: {
        id: "p1",
        name: "UI work",
        icon: "palette",
        provider: "claude",
        model: "claude-opus-5",
        modeId: "plan",
        thinkingOptionId: "think-hard",
        featureValues: { webSearch: true },
        notes: "Visual work only.",
      },
    });
    const state = model.getState();

    expect(state.name).toBe("UI work");
    expect(state.icon).toBe("palette");
    // Ids double as labels until the catalog arrives.
    expect(state.modelDisplay).toEqual({ label: "claude-opus-5" });
    expect(state.thinkingDisplay).toEqual({ label: "think-hard" });
    expect(state.catalogResolution).toBe("idle");
  });

  it("upgrades seeded displays to catalog labels without touching selections", () => {
    const model = openAgentProfileForm({
      mode: "edit",
      profile: {
        id: "p1",
        name: "UI work",
        provider: "claude",
        model: "claude-opus-5",
        modeId: "plan",
        thinkingOptionId: "think-hard",
      },
    });
    model.applyProviderCatalog(ENTRIES);
    const state = model.getState();

    expect(state.providerDisplay).toEqual({ label: "Claude Code" });
    expect(state.modelDisplay).toEqual({ label: "Opus 5" });
    expect(state.modeDisplay).toEqual({ label: "Plan" });
    expect(state.thinkingDisplay).toEqual({ label: "Think hard" });
    expect(state.modelId).toBe("claude-opus-5");
    expect(state.catalogResolution).toBe("complete");
  });

  it("keeps a stored value the catalog does not know", () => {
    const model = openAgentProfileForm({
      mode: "edit",
      profile: { id: "p1", name: "Legacy", provider: "claude", model: "claude-retired-3" },
    });
    model.applyProviderCatalog(ENTRIES);

    expect(model.getState().modelId).toBe("claude-retired-3");
    expect(model.getState().modelDisplay).toEqual({ label: "claude-retired-3" });
    expect(model.getState().disclosure.showModelField).toBe(true);
  });

  describe("provider cascade", () => {
    it("clears every provider-scoped selection when the provider changes", () => {
      const model = openWithCatalog({ mode: "create" });
      model.setName("Test writer");
      selectClaude(model);
      model.setModel("claude-opus-5", { label: "Opus 5" });
      model.setThinking("think-hard", { label: "Think hard" });
      model.applyFeatures(model.getState().featureRequestKey ?? "", [
        { type: "toggle", id: "webSearch", label: "Web search", value: false },
      ]);
      model.setFeatureValue("webSearch", true);

      model.setProvider("codex", { label: "Codex" });
      const state = model.getState();

      expect(state.modelId).toBe("");
      expect(state.modelDisplay).toBeNull();
      expect(state.thinkingOptionId).toBe("");
      expect(state.thinkingDisplay).toBeNull();
      expect(state.featureValues).toEqual({});
      expect(state.features).toEqual([]);
      expect(state.name).toBe("Test writer");
    });

    it("seeds the new provider's default mode", () => {
      const model = openWithCatalog({ mode: "create" });
      selectClaude(model);

      expect(model.getState().modeId).toBe("plan");

      model.setProvider("codex", { label: "Codex" });
      expect(model.getState().modeId).toBe("");
    });

    it("re-populates model, mode and thinking options from the new provider", () => {
      const model = openWithCatalog({ mode: "create" });
      selectClaude(model);

      expect(optionValues(model.getState().modelOptions)).toEqual([
        "",
        "claude-opus-5",
        "claude-haiku-4-5",
      ]);
      expect(optionValues(model.getState().thinkingOptions)).toEqual(["", "think", "think-hard"]);

      model.setProvider("codex", { label: "Codex" });

      expect(optionValues(model.getState().modelOptions)).toEqual(["", "gpt-5.2-codex"]);
      expect(optionValues(model.getState().modeOptions)).toEqual(["", "read-only"]);
      // GPT-5.2 Codex declares no thinking options, so the field disappears.
      expect(model.getState().thinkingOptions).toEqual([]);
      expect(model.getState().disclosure.showThinkingField).toBe(false);
    });

    it("ignores a no-op provider selection", () => {
      const model = openWithCatalog({ mode: "create" });
      selectClaude(model);
      model.setModel("claude-opus-5", { label: "Opus 5" });

      selectClaude(model);

      expect(model.getState().modelId).toBe("claude-opus-5");
    });
  });

  describe("model cascade", () => {
    it("drops a thinking level the new model does not offer", () => {
      const model = openWithCatalog({ mode: "create" });
      selectClaude(model);
      model.setModel("claude-opus-5", { label: "Opus 5" });
      model.setThinking("think-hard", { label: "Think hard" });

      model.setModel("claude-haiku-4-5", { label: "Haiku 4.5" });

      expect(model.getState().thinkingOptionId).toBe("");
      expect(model.getState().thinkingDisplay).toBeNull();
    });

    it("keeps a thinking level the new model still offers", () => {
      const model = openWithCatalog({ mode: "create" });
      selectClaude(model);
      model.setModel("claude-opus-5", { label: "Opus 5" });
      model.setThinking("think", { label: "Think" });

      model.setModel("claude-haiku-4-5", { label: "Haiku 4.5" });

      expect(model.getState().thinkingOptionId).toBe("think");
    });

    it("resolves thinking options from the default model while the model is unset", () => {
      const model = openWithCatalog({ mode: "create" });
      selectClaude(model);

      expect(model.getState().modelId).toBe("");
      expect(optionValues(model.getState().thinkingOptions)).toEqual(["", "think", "think-hard"]);
    });
  });

  describe("features", () => {
    it("asks for features per provider/model/mode/thinking combination", () => {
      const model = openWithCatalog({ mode: "create" });
      selectClaude(model);

      expect(model.getState().featureRequest).toEqual({ provider: "claude", modeId: "plan" });
      const firstKey = model.getState().featureRequestKey;

      model.setModel("claude-opus-5", { label: "Opus 5" });

      expect(model.getState().featureRequestKey).not.toBe(firstKey);
      expect(model.getState().featureRequest).toEqual({
        provider: "claude",
        model: "claude-opus-5",
        modeId: "plan",
      });
    });

    it("moves from pending to complete only for the current request", () => {
      const model = openWithCatalog({ mode: "create" });
      selectClaude(model);
      const key = model.getState().featureRequestKey ?? "";
      expect(model.getState().featureResolution).toBe("pending");

      model.applyFeatures("stale-key", [
        { type: "toggle", id: "webSearch", label: "Web search", value: false },
      ]);
      expect(model.getState().featureResolution).toBe("pending");
      expect(model.getState().features).toEqual([]);

      model.applyFeatures(key, [
        { type: "toggle", id: "webSearch", label: "Web search", value: false },
      ]);
      expect(model.getState().featureResolution).toBe("complete");
      expect(model.getState().disclosure.showFeaturesField).toBe(true);
    });

    it("reflects a set feature value back into the rendered feature", () => {
      const model = openWithCatalog({ mode: "create" });
      selectClaude(model);
      model.applyFeatures(model.getState().featureRequestKey ?? "", [
        { type: "toggle", id: "webSearch", label: "Web search", value: false },
      ]);

      model.setFeatureValue("webSearch", true);

      expect(model.getState().features[0]).toMatchObject({ id: "webSearch", value: true });
      expect(model.getState().featureValues).toEqual({ webSearch: true });
    });

    it("keeps stored feature values while the feature list is still pending", () => {
      const model = openAgentProfileForm({
        mode: "edit",
        profile: {
          id: "p1",
          name: "UI work",
          provider: "claude",
          featureValues: { webSearch: true },
        },
      });
      model.applyProviderCatalog(ENTRIES);

      expect(model.getState().featureResolution).toBe("pending");
      expect(model.getState().submitValue?.featureValues).toEqual({ webSearch: true });
    });

    it("prunes stored values the provider no longer reports", () => {
      const model = openAgentProfileForm({
        mode: "edit",
        profile: {
          id: "p1",
          name: "UI work",
          provider: "claude",
          featureValues: { webSearch: true, retiredFlag: true },
        },
      });
      model.applyProviderCatalog(ENTRIES);
      model.applyFeatures(model.getState().featureRequestKey ?? "", [
        { type: "toggle", id: "webSearch", label: "Web search", value: false },
      ]);

      expect(model.getState().featureValues).toEqual({ webSearch: true });
    });

    it("resolves an unavailable feature listing without showing the field", () => {
      const model = openWithCatalog({ mode: "create" });
      selectClaude(model);

      model.applyFeaturesUnavailable(model.getState().featureRequestKey ?? "");

      expect(model.getState().featureResolution).toBe("complete");
      expect(model.getState().disclosure.showFeaturesField).toBe(false);
    });
  });

  it("blocks submission while a save is in flight", () => {
    const model = openWithCatalog({ mode: "create" });
    model.setName("UI work");
    selectClaude(model);

    model.setSubmitting(true);
    expect(model.getState().canSubmit).toBe(false);

    model.setSubmitting(false);
    expect(model.getState().canSubmit).toBe(true);
  });

  it("stops publishing after close", () => {
    const model = openWithCatalog({ mode: "create" });
    let notifications = 0;
    model.subscribe(() => {
      notifications += 1;
    });

    model.setName("a");
    expect(notifications).toBe(1);

    model.close();
    model.setName("b");
    expect(notifications).toBe(1);
    expect(model.getState().name).toBe("a");
  });
});

describe("buildFeatureRequestKey", () => {
  it("is null without a provider", () => {
    expect(buildFeatureRequestKey(null)).toBeNull();
  });

  it("separates the fields so a value cannot bleed across positions", () => {
    expect(buildFeatureRequestKey({ provider: "claude", model: "a|b" })).toBe("claude|a|b||");
    expect(buildFeatureRequestKey({ provider: "claude", modeId: "a" })).not.toBe(
      buildFeatureRequestKey({ provider: "claude", model: "a" }),
    );
  });
});
