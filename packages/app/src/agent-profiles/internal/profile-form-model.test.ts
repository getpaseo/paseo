import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { describe, expect, it } from "vitest";
import {
  buildControlsRequestKey,
  buildInstantAgentProfile,
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

function optionIds(options: readonly { id: string }[]): string[] {
  return options.map((option) => option.id);
}

const FAST = {
  controls: [{ type: "toggle" as const, key: "fast_mode", label: "Fast" }],
  options: { fast_mode: false },
};
const NO_CONTROLS = { controls: [], options: {} };

function toggledOnOpus(): AgentProfileFormModel {
  const model = openWithCatalog({ mode: "create" });
  model.setName("Fast");
  selectClaude(model);
  model.applyControls(model.getState().controlsRequestKey ?? "", FAST);
  model.setOption("fast_mode", true);
  return model;
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

  it("seeds create mode from a model seed before the catalog lands", () => {
    const model = openAgentProfileForm({
      mode: "create",
      seed: { provider: "claude", modelId: "claude-opus-5", name: "Opus 5" },
    });
    const state = model.getState();

    expect(state.name).toBe("Opus 5");
    expect(state.provider).toBe("claude");
    expect(state.modelId).toBe("claude-opus-5");
    expect(state.providerDisplay).toEqual({ label: "claude" });
    expect(state.modelDisplay).toEqual({ label: "claude-opus-5" });
    expect(state.catalogResolution).toBe("idle");
  });

  it("upgrades a seeded model to catalog labels without touching the selection", () => {
    const model = openAgentProfileForm({
      mode: "create",
      seed: { provider: "claude", modelId: "claude-opus-5", name: "Opus 5" },
    });
    model.applyProviderCatalog(ENTRIES);
    const state = model.getState();

    expect(state.providerDisplay).toEqual({ label: "Claude Code" });
    expect(state.modelDisplay).toEqual({ label: "Opus 5" });
    expect(state.modelId).toBe("claude-opus-5");
    expect(state.canSubmit).toBe(true);
    expect(state.submitValue).toMatchObject({
      name: "Opus 5",
      provider: "claude",
      model: "claude-opus-5",
    });
  });

  it("ignores the seed in edit mode", () => {
    const model = openAgentProfileForm({
      mode: "edit",
      profile: { id: "p1", name: "UI work", provider: "claude", model: "claude-haiku-4-5" },
      seed: { provider: "codex", modelId: "gpt-5.2-codex", name: "Nope" },
    });
    const state = model.getState();

    expect(state.name).toBe("UI work");
    expect(state.provider).toBe("claude");
    expect(state.modelId).toBe("claude-haiku-4-5");
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

  it("omits blank text fields from the submitted value but never a selection", () => {
    const model = openWithCatalog({ mode: "create" });
    model.setName("  Cheap grunt  ");
    model.setProvider("codex", { label: "Codex" });
    model.setSystemPrompt("   ");
    model.setNotes("   ");

    // Codex declares no thinking options, so that key is genuinely absent —
    // model and mode are seeded, never left for the host to decide.
    // `options` and `systemPrompt` stay present when empty so the daemon can
    // distinguish an intentional clear from an older app that predates them.
    expect(model.getState().submitValue).toEqual({
      name: "Cheap grunt",
      provider: "codex",
      model: "gpt-5.2-codex",
      modeId: "read-only",
      options: {},
      systemPrompt: "",
    });
  });

  it("seeds, tracks dirty state, preserves across provider switches, and submits systemPrompt", () => {
    const model = openWithCatalog({
      mode: "edit",
      profile: {
        id: "p1",
        name: "UI work",
        provider: "claude",
        model: "claude-opus-5",
        systemPrompt: "Focus on layout.",
      },
    });
    expect(model.getState().systemPrompt).toBe("Focus on layout.");
    expect(model.getState().isDirty).toBe(false);

    model.setSystemPrompt("  Focus on layout and tokens.  ");
    expect(model.getState().isDirty).toBe(true);
    expect(model.getState().submitValue?.systemPrompt).toBe("Focus on layout and tokens.");

    model.setProvider("codex", { label: "Codex" });
    expect(model.getState().systemPrompt).toBe("  Focus on layout and tokens.  ");
    expect(model.getState().submitValue?.systemPrompt).toBe("Focus on layout and tokens.");
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
        options: { webSearch: true },
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
    it("reseeds every provider-scoped selection when the provider changes", () => {
      const model = openWithCatalog({ mode: "create" });
      model.setName("Test writer");
      selectClaude(model);
      model.setModel("claude-opus-5", { label: "Opus 5" });
      model.setThinking("think-hard", { label: "Think hard" });
      model.applyControls(model.getState().controlsRequestKey ?? "", {
        controls: [{ type: "toggle", key: "webSearch", label: "Web search" }],
        options: { webSearch: false },
      });
      model.setOption("webSearch", true);

      model.setProvider("codex", { label: "Codex" });
      const state = model.getState();

      // Claude's ids mean nothing under Codex, so each field lands on Codex's own default.
      expect(state.modelId).toBe("gpt-5.2-codex");
      expect(state.modelDisplay).toEqual({ label: "GPT-5.2 Codex" });
      expect(state.thinkingOptionId).toBe("");
      expect(state.thinkingDisplay).toBeNull();
      expect(state.options).toEqual({});
      expect(state.optionEdits).toEqual({});
      expect(state.controls).toEqual([]);
      expect(state.name).toBe("Test writer");
    });

    it("seeds each provider's default mode", () => {
      const model = openWithCatalog({ mode: "create" });
      selectClaude(model);

      expect(model.getState().modeId).toBe("plan");

      // Codex declares no defaultModeId, so the first mode it offers stands in.
      model.setProvider("codex", { label: "Codex" });
      expect(model.getState().modeId).toBe("read-only");
    });

    it("re-populates model, mode and thinking options from the new provider", () => {
      const model = openWithCatalog({ mode: "create" });
      selectClaude(model);

      expect(optionValues(model.getState().modelOptions)).toEqual([
        "claude-opus-5",
        "claude-haiku-4-5",
      ]);
      expect(optionValues(model.getState().thinkingOptions)).toEqual(["think", "think-hard"]);

      model.setProvider("codex", { label: "Codex" });

      expect(optionValues(model.getState().modelOptions)).toEqual(["gpt-5.2-codex"]);
      expect(optionValues(model.getState().modeOptions)).toEqual(["read-only"]);
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
    it("reseeds a thinking level the new model does not offer", () => {
      const model = openWithCatalog({ mode: "create" });
      selectClaude(model);
      model.setModel("claude-opus-5", { label: "Opus 5" });
      model.setThinking("think-hard", { label: "Think hard" });

      // Haiku offers only "think", so "think-hard" cannot survive the switch.
      model.setModel("claude-haiku-4-5", { label: "Haiku 4.5" });

      expect(model.getState().thinkingOptionId).toBe("think");
      expect(model.getState().thinkingDisplay).toEqual({ label: "Think" });
    });

    it("keeps a thinking level the new model still offers", () => {
      const model = openWithCatalog({ mode: "create" });
      selectClaude(model);
      model.setModel("claude-opus-5", { label: "Opus 5" });
      model.setThinking("think", { label: "Think" });

      model.setModel("claude-haiku-4-5", { label: "Haiku 4.5" });

      expect(model.getState().thinkingOptionId).toBe("think");
    });

    it("seeds the provider's default model and reads thinking options from it", () => {
      const model = openWithCatalog({ mode: "create" });
      selectClaude(model);

      expect(model.getState().modelId).toBe("claude-opus-5");
      expect(optionValues(model.getState().thinkingOptions)).toEqual(["think", "think-hard"]);
      expect(model.getState().thinkingOptionId).toBe("think");
    });

    it("offers no way to unset a selection", () => {
      const model = openWithCatalog({ mode: "create" });
      selectClaude(model);
      const state = model.getState();

      const everyOption = [...state.modelOptions, ...state.modeOptions, ...state.thinkingOptions];

      expect(everyOption.length).toBeGreaterThan(0);
      expect(optionValues(everyOption)).not.toContain("");
    });
  });

  const WEB_SEARCH_CONTROLS = {
    controls: [{ type: "toggle" as const, key: "webSearch", label: "Web search" }],
    options: { webSearch: false },
  };

  describe("controls", () => {
    it("asks for controls per provider/model/mode/thinking combination", () => {
      const model = openWithCatalog({ mode: "create" });
      selectClaude(model);

      expect(model.getState().controlsRequest).toEqual({
        provider: "claude",
        model: "claude-opus-5",
        modeId: "plan",
        thinkingOptionId: "think",
      });
      const firstKey = model.getState().controlsRequestKey;

      model.setModel("claude-haiku-4-5", { label: "Haiku 4.5" });

      expect(model.getState().controlsRequestKey).not.toBe(firstKey);
      expect(model.getState().controlsRequest).toEqual({
        provider: "claude",
        model: "claude-haiku-4-5",
        modeId: "plan",
        thinkingOptionId: "think",
      });
    });

    it("moves from pending to complete only for the current request", () => {
      const model = openWithCatalog({ mode: "create" });
      selectClaude(model);
      const key = model.getState().controlsRequestKey ?? "";
      expect(model.getState().controlsResolution).toBe("pending");

      model.applyControls("stale-key", {
        controls: [{ type: "toggle", key: "webSearch", label: "Web search" }],
        options: { webSearch: false },
      });
      expect(model.getState().controlsResolution).toBe("pending");
      expect(model.getState().controls).toEqual([]);

      model.applyControls(key, {
        controls: [{ type: "toggle", key: "webSearch", label: "Web search" }],
        options: { webSearch: false },
      });
      expect(model.getState().controlsResolution).toBe("complete");
      expect(model.getState().disclosure.showControlsField).toBe(true);
    });

    it("reflects a set option back into the rendered controls", () => {
      const model = openWithCatalog({ mode: "create" });
      model.setName("Searcher");
      selectClaude(model);
      model.applyControls(model.getState().controlsRequestKey ?? "", WEB_SEARCH_CONTROLS);

      model.setOption("webSearch", true);

      expect(model.getState().controls[0]).toMatchObject({ key: "webSearch" });
      expect(model.getState().controlOptions).toEqual({ webSearch: true });
      expect(model.getState().submitValue?.options).toEqual({ webSearch: true });
    });

    it("keeps stored options while the controls are still pending", () => {
      const model = openAgentProfileForm({
        mode: "edit",
        profile: { id: "p1", name: "UI work", provider: "claude", options: { webSearch: true } },
      });
      model.applyProviderCatalog(ENTRIES);

      expect(model.getState().controlsResolution).toBe("pending");
      expect(model.getState().submitValue?.options).toEqual({ webSearch: true });
    });

    it("keeps options no control draws, so editing a profile does not drop them", () => {
      const model = openAgentProfileForm({
        mode: "edit",
        profile: {
          id: "p1",
          name: "UI work",
          provider: "claude",
          options: { webSearch: true, sandbox_mode: "read-only" },
        },
      });
      model.applyProviderCatalog(ENTRIES);
      model.applyControls(model.getState().controlsRequestKey ?? "", WEB_SEARCH_CONTROLS);
      model.setOption("webSearch", false);

      expect(model.getState().submitValue?.options).toEqual({
        webSearch: false,
        sandbox_mode: "read-only",
      });
    });

    it("draws the options the daemon resolved from the stored ones, then the edits", () => {
      const model = openAgentProfileForm({
        mode: "edit",
        profile: { id: "p1", name: "Fast", provider: "codex", options: { service_tier: "fast" } },
      });
      model.applyProviderCatalog(ENTRIES);

      // The request carries the stored options so the daemon can resolve the legacy tier.
      expect(model.getState().controlsRequest?.providerOptions).toEqual({ service_tier: "fast" });

      model.applyControls(model.getState().controlsRequestKey ?? "", {
        controls: [
          {
            type: "select",
            key: "service_tier",
            label: "Speed",
            defaultValue: "default",
            choices: [
              { value: "default", label: "Standard" },
              { value: "priority", label: "Fast" },
            ],
          },
        ],
        options: { service_tier: "priority" },
      });

      expect(model.getState().controlOptions).toEqual({ service_tier: "priority" });
      // Nothing was edited, so the stored value is saved as it was.
      expect(model.getState().submitValue?.options).toEqual({ service_tier: "fast" });
    });

    it("sends an edit to the daemon with the stored options, and draws the answer", () => {
      const model = openAgentProfileForm({
        mode: "edit",
        profile: {
          id: "p1",
          name: "Fast",
          provider: "codex",
          options: { service_tier: "fast", sandbox_mode: "read-only" },
        },
      });
      model.applyProviderCatalog(ENTRIES);
      const speed = {
        controls: [
          {
            type: "select" as const,
            key: "service_tier",
            label: "Speed",
            defaultValue: "default",
            choices: [
              { value: "default", label: "Standard" },
              { value: "priority", label: "Fast" },
            ],
          },
        ],
        options: { service_tier: "priority", sandbox_mode: "read-only" },
      };
      model.applyControls(model.getState().controlsRequestKey ?? "", speed);

      model.setOption("service_tier", "default");

      // The controls stay up while the daemon answers, with the toggle laid over the last answer.
      expect(model.getState().controls).toHaveLength(1);
      expect(model.getState().controlOptions).toMatchObject({ service_tier: "default" });
      // The request carries everything the profile would save, so the daemon resolves it.
      expect(model.getState().controlsRequest?.providerOptions).toEqual({
        service_tier: "default",
        sandbox_mode: "read-only",
      });
      expect(model.getState().controlsResolution).toBe("pending");

      model.applyControls(model.getState().controlsRequestKey ?? "", {
        ...speed,
        options: { service_tier: "default", sandbox_mode: "read-only" },
      });
      expect(model.getState().controlsResolution).toBe("complete");
      expect(model.getState().controlOptions).toEqual({
        service_tier: "default",
        sandbox_mode: "read-only",
      });
    });

    it("keeps previous provider controls mounted while another model's answer is pending to prevent layout jank", () => {
      const model = openWithCatalog({ mode: "create" });
      selectClaude(model);
      model.applyControls(model.getState().controlsRequestKey ?? "", WEB_SEARCH_CONTROLS);

      model.setModel("claude-haiku-4-5", { label: "Haiku 4.5" });

      expect(model.getState().controlsResolution).toBe("pending");
      expect(model.getState().controlsPending).toBe(true);
      expect(model.getState().controls).toHaveLength(1);

      // Switching providers clears controls immediately so stale controls never cross providers.
      model.setProvider("codex", { label: "Codex" });
      expect(model.getState().controls).toEqual([]);
    });

    it("seeds the catalog synchronously when entries are passed in the initial snapshot", () => {
      const model = openAgentProfileForm({
        mode: "edit",
        profile: { id: "p1", name: "UI work", provider: "claude", model: "claude-opus-5" },
        entries: ENTRIES,
      });
      const state = model.getState();

      expect(state.catalogResolution).toBe("complete");
      expect(state.providerDisplay).toEqual({ label: "Claude Code" });
      expect(state.modelDisplay).toEqual({ label: "Opus 5" });
      expect(optionIds(state.unifiedModelOptions)).toEqual([
        "claude:claude-opus-5",
        "claude:claude-haiku-4-5",
        "codex:gpt-5.2-codex",
      ]);
    });

    it("updates provider, model, and auto-suggested name together via setProviderModel", () => {
      const model = openAgentProfileForm({ mode: "create", entries: ENTRIES });

      model.setProviderModel("claude", "claude-opus-5", {
        provider: { label: "Claude Code" },
        model: { label: "Opus 5" },
      });
      expect(model.getState().name).toBe("Opus 5");
      expect(model.getState().provider).toBe("claude");
      expect(model.getState().modelId).toBe("claude-opus-5");
      expect(model.getState().modeId).toBe("plan");
      expect(model.getState().thinkingOptionId).toBe("think");

      // Switching to another model while untouched updates the suggested name.
      model.setProviderModel("codex", "gpt-5.2-codex", {
        provider: { label: "Codex" },
        model: { label: "GPT-5.2 Codex" },
      });
      expect(model.getState().name).toBe("GPT-5.2 Codex");
      expect(model.getState().provider).toBe("codex");
      expect(model.getState().modeId).toBe("read-only");

      // Once the user types a custom name, changing model preserves it.
      model.setName("My Custom Worker");
      model.setProviderModel("claude", "claude-haiku-4-5", {
        provider: { label: "Claude Code" },
        model: { label: "Haiku 4.5" },
      });
      expect(model.getState().name).toBe("My Custom Worker");
    });

    it("does not save a toggle once the model that drew it is replaced by one without it", () => {
      const model = toggledOnOpus();
      expect(model.getState().submitValue?.options).toEqual({ fast_mode: true });

      model.setModel("claude-haiku-4-5", { label: "Haiku 4.5" });
      model.applyControls(model.getState().controlsRequestKey ?? "", NO_CONTROLS);

      // Empty, not absent: the daemon reads a profile write without `options` as one from an
      // app that predates them and keeps the stored options.
      expect(model.getState().submitValue?.options).toEqual({});
      expect(model.getState().controlsRequest?.providerOptions).toBeUndefined();
    });

    it("saves a toggle again when the model that draws it returns", () => {
      const model = toggledOnOpus();
      model.setModel("claude-haiku-4-5", { label: "Haiku 4.5" });
      model.applyControls(model.getState().controlsRequestKey ?? "", NO_CONTROLS);

      model.setModel("claude-opus-5", { label: "Opus 5" });
      model.applyControls(model.getState().controlsRequestKey ?? "", FAST);

      expect(model.getState().submitValue?.options).toEqual({ fast_mode: true });
    });

    it("does not save a stored toggle profile either", () => {
      const model = openAgentProfileForm({
        mode: "edit",
        profile: {
          id: "p1",
          name: "Fast",
          provider: "claude",
          model: "claude-opus-5",
          options: { fast_mode: true },
        },
      });
      model.applyProviderCatalog(ENTRIES);
      model.applyControls(model.getState().controlsRequestKey ?? "", FAST);

      model.setModel("claude-haiku-4-5", { label: "Haiku 4.5" });
      model.applyControls(model.getState().controlsRequestKey ?? "", NO_CONTROLS);

      expect(model.getState().submitValue?.options).toEqual({});
    });

    it("never drops an option no control has drawn", () => {
      const model = openWithCatalog({ mode: "create" });
      model.setName("Fast");
      selectClaude(model);
      model.applyControls(model.getState().controlsRequestKey ?? "", FAST);
      model.setOption("token_budget", 8000);
      model.setOption("fast_mode", true);

      model.setModel("claude-haiku-4-5", { label: "Haiku 4.5" });
      model.applyControls(model.getState().controlsRequestKey ?? "", NO_CONTROLS);

      expect(model.getState().submitValue?.options).toEqual({ token_budget: 8000 });
    });

    it("keeps a toggle when the daemon cannot list controls", () => {
      const model = toggledOnOpus();

      model.setModel("claude-haiku-4-5", { label: "Haiku 4.5" });
      model.applyControlsUnavailable(model.getState().controlsRequestKey ?? "");

      expect(model.getState().submitValue?.options).toEqual({ fast_mode: true });
    });

    it("resolves an unavailable feature listing without showing the field", () => {
      const model = openWithCatalog({ mode: "create" });
      selectClaude(model);

      model.applyControlsUnavailable(model.getState().controlsRequestKey ?? "");

      expect(model.getState().controlsResolution).toBe("complete");
      expect(model.getState().disclosure.showControlsField).toBe(false);
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

  it("does not treat catalog-prefilled defaults on a minimal profile as an unsaved edit", () => {
    const model = openAgentProfileForm({
      mode: "edit",
      profile: {
        id: "legacy_favorite:claude:claude-opus-5",
        name: "Opus 5",
        provider: "claude",
        model: "claude-opus-5",
      },
    });
    expect(model.getState().isDirty).toBe(false);

    // Catalog fills in default modeId ("plan") and thinkingOptionId ("think").
    model.applyProviderCatalog(ENTRIES);
    expect(model.getState().modeId).toBe("plan");
    expect(model.getState().thinkingOptionId).toBe("think");
    expect(model.getState().isDirty).toBe(false);

    // User edit marks dirty and advances draftRevision; a subsequent edit advances it again.
    expect(model.getState().draftRevision).toBe(0);
    model.setName("Renamed");
    expect(model.getState().isDirty).toBe(true);
    expect(model.getState().draftRevision).toBe(1);
    model.setName("Renamed again");
    expect(model.getState().draftRevision).toBe(2);
    model.setName("Opus 5");
    expect(model.getState().isDirty).toBe(false);
    expect(model.getState().draftRevision).toBe(3);
  });
});

describe("buildControlsRequestKey", () => {
  it("is null without a provider", () => {
    expect(buildControlsRequestKey(null)).toBeNull();
  });

  it("separates the fields so a value cannot bleed across positions", () => {
    expect(buildControlsRequestKey({ provider: "claude", model: "a|b" })).toBe("claude|a|b||");
    expect(buildControlsRequestKey({ provider: "claude", modeId: "a" })).not.toBe(
      buildControlsRequestKey({ provider: "claude", model: "a" }),
    );
  });
});

describe("buildInstantAgentProfile", () => {
  it("builds a concrete profile with provider defaults from a model seed", () => {
    expect(
      buildInstantAgentProfile({
        seed: { provider: "claude", modelId: "claude-opus-5", name: "Opus 5" },
        entries: ENTRIES,
      }),
    ).toEqual({
      name: "Opus 5",
      provider: "claude",
      model: "claude-opus-5",
      modeId: "plan",
      thinkingOptionId: "think",
      options: {},
    });
  });

  it("keeps compatible preferred mode and thinking levels and ignores incompatible ones", () => {
    expect(
      buildInstantAgentProfile({
        seed: { provider: "claude", modelId: "claude-opus-5" },
        entries: ENTRIES,
        preferredModeId: "accept-edits",
        preferredThinkingOptionId: "think-hard",
      }),
    ).toEqual({
      name: "Opus 5",
      provider: "claude",
      model: "claude-opus-5",
      modeId: "accept-edits",
      thinkingOptionId: "think-hard",
      options: {},
    });

    expect(
      buildInstantAgentProfile({
        seed: { provider: "claude", modelId: "claude-haiku-4-5" },
        entries: ENTRIES,
        preferredModeId: "unknown-mode",
        preferredThinkingOptionId: "think-hard",
      }),
    ).toEqual({
      name: "Haiku 4.5",
      provider: "claude",
      model: "claude-haiku-4-5",
      modeId: "plan",
      thinkingOptionId: "think",
      options: {},
    });
  });
});
