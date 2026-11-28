import { describe, expect, it } from "vitest";
import type {
  ProviderSelectionModelRow,
  ProviderSelectorProvider,
} from "@/provider-selection/provider-selection";
import {
  MODEL_PICKER_PROFILES_RAIL_KEY,
  createModelPickerState,
  projectModelPicker,
  reduceModelPicker,
  resolveModelPickerHeight,
  resolveModelPickerKey,
  resolveModelPickerLayout,
  type ModelPickerInput,
  type ModelPickerKeyResult,
  type ModelPickerListItem,
  type ModelPickerProjection,
  type ModelPickerState,
} from "./model-browser-panes-view";

interface Profile {
  id: string;
  provider: string;
  modelId: string;
  name: string;
  summary: string;
}

function row(
  providerId: string,
  providerLabel: string,
  modelId: string,
  options: { legacy?: boolean; label?: string } = {},
): ProviderSelectionModelRow {
  return {
    favoriteKey: `${providerId}:${modelId}`,
    provider: providerId,
    providerLabel,
    modelId,
    modelLabel: options.label ?? modelId,
    description: `${modelId} description`,
    ...(options.legacy ? { legacy: true } : {}),
  };
}

const claudeCurrent = ["opus-5.5", "fable-5.2", "sonnet-5.5", "haiku-5.5"];
const claudeOlder = Array.from({ length: 15 }, (_, index) => `claude-older-${index + 1}`);
const claude: ProviderSelectorProvider = {
  id: "claude",
  label: "Claude",
  modelSelection: {
    kind: "models",
    rows: [
      ...claudeCurrent.map((id) => row("claude", "Claude", id)),
      ...claudeOlder.map((id) => row("claude", "Claude", id, { legacy: true })),
    ],
  },
};
const codex: ProviderSelectorProvider = {
  id: "codex",
  label: "Codex",
  modelSelection: {
    kind: "models",
    rows: [row("codex", "Codex", "gpt-5.4"), row("codex", "Codex", "gpt-5.4-mini")],
  },
};
const pi: ProviderSelectorProvider = {
  id: "pi",
  label: "Pi",
  shownModels: ["anthropic/opus", "openai/gpt-5"],
  modelSelection: {
    kind: "models",
    rows: [
      row("pi", "Pi", "anthropic/opus"),
      row("pi", "Pi", "openai/gpt-5"),
      row("pi", "Pi", "openai/gpt-5.4"),
      row("pi", "Pi", "google/gemini"),
    ],
  },
};
const copilot: ProviderSelectorProvider = {
  id: "copilot",
  label: "Copilot",
  modelSelection: { kind: "error", message: "Not signed in" },
};
const opencode: ProviderSelectorProvider = {
  id: "opencode",
  label: "OpenCode",
  modelSelection: { kind: "loading" },
};

const profiles: Profile[] = [
  {
    id: "deep-review",
    provider: "codex",
    modelId: "gpt-5.4",
    name: "Codex 5.4 Deep Review",
    summary: "Codex · GPT-5.4 · High",
  },
  {
    id: "quick",
    provider: "claude",
    modelId: "haiku-5.5",
    name: "Quick fixes",
    summary: "Claude · Haiku 5.5",
  },
];

function input(overrides: Partial<ModelPickerInput<Profile>> = {}): ModelPickerInput<Profile> {
  return {
    providers: [claude, copilot, codex, opencode, pi],
    profiles,
    canCreateProfile: true,
    selectedProvider: "claude",
    selectedModel: "opus-5.5",
    ...overrides,
  };
}

function open(pickerInput: ModelPickerInput<Profile>) {
  const state = createModelPickerState(pickerInput);
  return { state, projection: projectModelPicker(pickerInput, state) };
}

function keys(items: readonly ModelPickerListItem<Profile>[]): string[] {
  return items.map((item) => item.key);
}

function modelIds(projection: ModelPickerProjection<Profile>): string[] {
  return projection.pane.items.flatMap((item) => (item.kind === "model" ? [item.row.modelId] : []));
}

function press(
  pickerInput: ModelPickerInput<Profile>,
  state: ModelPickerState,
  key: string,
  options: { focusedControlOwnsEnter?: boolean; shiftKey?: boolean; metaKey?: boolean } = {},
): ModelPickerKeyResult {
  return resolveModelPickerKey(pickerInput, state, {
    event: { key, shiftKey: options.shiftKey, metaKey: options.metaKey },
    focusedControlOwnsEnter: options.focusedControlOwnsEnter ?? false,
  });
}

function nextState(result: ModelPickerKeyResult): ModelPickerState {
  if (result?.kind !== "state") throw new Error(`expected a state change, got ${result?.kind}`);
  return result.state;
}

describe("model picker layout", () => {
  it("uses two panes for several providers", () => {
    expect(resolveModelPickerLayout(input({ profiles: null }))).toBe("twoPane");
  });

  it("uses two panes for one provider with profiles", () => {
    expect(resolveModelPickerLayout(input({ providers: [claude] }))).toBe("twoPane");
  });

  it("keeps two panes for one provider on a surface that offers profiles but has none", () => {
    expect(resolveModelPickerLayout(input({ providers: [claude], profiles: [] }))).toBe("twoPane");
  });

  it("drops the rail for one provider on a surface without profiles", () => {
    expect(resolveModelPickerLayout(input({ providers: [claude], profiles: null }))).toBe(
      "singlePane",
    );
  });

  it("keeps a fixed two-pane height whatever the content", () => {
    const tall = resolveModelPickerHeight(input());
    expect(resolveModelPickerHeight(input({ providers: [codex, pi] }))).toBe(tall);
  });

  it("sizes the single pane from every row, folded or not, so expanding never resizes it", () => {
    const small = resolveModelPickerHeight(input({ providers: [codex], profiles: null }));
    const large = resolveModelPickerHeight(input({ providers: [claude], profiles: null }));
    expect(small).toBeLessThan(large);
    expect(large).toBe(resolveModelPickerHeight(input()));
  });
});

describe("model picker rail", () => {
  it("lists Profiles, then ready providers, then errored providers after a divider", () => {
    const { projection } = open(input());
    expect(projection.rail.map((item) => item.key)).toEqual([
      MODEL_PICKER_PROFILES_RAIL_KEY,
      "claude",
      "codex",
      "opencode",
      "pi",
      "copilot",
    ]);
    const copilotItem = projection.rail.find((item) => item.key === "copilot");
    expect(copilotItem).toMatchObject({
      kind: "provider",
      status: "error",
      startsErrorGroup: true,
    });
  });

  it("counts profiles and the models each provider shows first", () => {
    const { projection } = open(input());
    const counts = Object.fromEntries(projection.rail.map((item) => [item.key, item.count]));
    expect(counts).toMatchObject({ profiles: 2, claude: 4, codex: 2, pi: 2 });
  });

  it("omits the Profiles row when the surface shows no profiles", () => {
    const { projection } = open(input({ profiles: null }));
    expect(projection.rail.map((item) => item.key)).not.toContain(MODEL_PICKER_PROFILES_RAIL_KEY);
  });

  it("has no rail in the single-pane layout", () => {
    const { projection } = open(input({ providers: [claude], profiles: null }));
    expect(projection.rail).toEqual([]);
  });
});

describe("model picker initial selection", () => {
  it("opens on the selected provider with its model active", () => {
    const { projection } = open(input());
    expect(projection.railKey).toBe("claude");
    expect(projection.focus).toBe("list");
    expect(projection.activeKey).toBe("model:claude:opus-5.5");
  });

  it("opens on Profiles when nothing is selected and profiles exist", () => {
    const { projection } = open(input({ selectedProvider: "", selectedModel: "" }));
    expect(projection.railKey).toBe(MODEL_PICKER_PROFILES_RAIL_KEY);
    expect(projection.pane.kind).toBe("profiles");
  });

  it("opens on the first ready provider when nothing is selected and there are no profiles", () => {
    const { projection } = open(
      input({ providers: [copilot, opencode, codex], profiles: null, selectedProvider: "" }),
    );
    expect(projection.railKey).toBe("codex");
  });
});

describe("model picker provider pane", () => {
  it("shows the current Claude models and folds the 15 older ones", () => {
    const { projection } = open(input());
    expect(projection.pane).toMatchObject({
      kind: "provider",
      providerId: "claude",
      label: "Claude",
      shown: 4,
      total: 19,
      foldKind: "older",
    });
    expect(modelIds(projection)).toEqual(claudeCurrent);
    expect(projection.pane.items.at(-1)).toMatchObject({
      kind: "fold",
      foldKind: "older",
      count: 15,
      expanded: false,
    });
  });

  it("opens the fold when the selected model is folded", () => {
    const { projection } = open(input({ selectedModel: "claude-older-3" }));
    expect(projection.pane.items[4]).toMatchObject({ kind: "fold", expanded: true });
    expect(modelIds(projection)).toEqual([...claudeCurrent, ...claudeOlder]);
    expect(projection.activeKey).toBe("model:claude:claude-older-3");
  });

  it("toggles the fold in place", () => {
    const pickerInput = input();
    const { state } = open(pickerInput);
    const expanded = reduceModelPicker(state, {
      kind: "toggleFold",
      providerId: "claude",
      expanded: true,
    });
    expect(modelIds(projectModelPicker(pickerInput, expanded))).toHaveLength(19);
    const collapsed = reduceModelPicker(expanded, {
      kind: "toggleFold",
      providerId: "claude",
      expanded: false,
    });
    expect(modelIds(projectModelPicker(pickerInput, collapsed))).toEqual(claudeCurrent);
  });

  it("shows the picked models first and folds the rest behind All models", () => {
    const pickerInput = input();
    const state = reduceModelPicker(open(pickerInput).state, { kind: "selectRail", railKey: "pi" });
    const projection = projectModelPicker(pickerInput, state);
    expect(modelIds(projection)).toEqual(["anthropic/opus", "openai/gpt-5"]);
    expect(projection.pane).toMatchObject({ shown: 2, total: 4, foldKind: "all" });
    expect(projection.pane.items.at(-1)).toMatchObject({ kind: "fold", foldKind: "all", count: 2 });
  });

  it("shows every model without a fold when nothing is folded", () => {
    const pickerInput = input();
    const state = reduceModelPicker(open(pickerInput).state, {
      kind: "selectRail",
      railKey: "codex",
    });
    const projection = projectModelPicker(pickerInput, state);
    expect(projection.pane).toMatchObject({ kind: "provider", foldKind: null });
    expect(keys(projection.pane.items)).toEqual([
      "model:codex:gpt-5.4",
      "model:codex:gpt-5.4-mini",
    ]);
    expect(projection.activeKey).toBe("model:codex:gpt-5.4");
  });

  it("shows loading and error states for providers without models", () => {
    const pickerInput = input();
    const loading = reduceModelPicker(open(pickerInput).state, {
      kind: "selectRail",
      railKey: "opencode",
    });
    expect(projectModelPicker(pickerInput, loading).pane).toMatchObject({
      kind: "providerLoading",
      items: [],
    });
    const errored = reduceModelPicker(loading, { kind: "selectRail", railKey: "copilot" });
    expect(projectModelPicker(pickerInput, errored).pane).toMatchObject({
      kind: "providerError",
      providerId: "copilot",
      message: "Not signed in",
      items: [],
    });
  });

  it("lists profiles on the Profiles pane, or offers to create one", () => {
    const pickerInput = input();
    const state = reduceModelPicker(open(pickerInput).state, {
      kind: "selectRail",
      railKey: MODEL_PICKER_PROFILES_RAIL_KEY,
    });
    expect(keys(projectModelPicker(pickerInput, state).pane.items)).toEqual([
      "profile:deep-review",
      "profile:quick",
    ]);
    const empty = input({ profiles: [] });
    expect(
      keys(
        projectModelPicker(
          empty,
          reduceModelPicker(createModelPickerState(empty), {
            kind: "selectRail",
            railKey: MODEL_PICKER_PROFILES_RAIL_KEY,
          }),
        ).pane.items,
      ),
    ).toEqual(["create-profile"]);
  });

  it("falls back to the first rail row when the open provider disappears", () => {
    const pickerInput = input();
    const state = reduceModelPicker(open(pickerInput).state, { kind: "selectRail", railKey: "pi" });
    const projection = projectModelPicker(input({ providers: [claude, codex] }), state);
    expect(projection.railKey).toBe(MODEL_PICKER_PROFILES_RAIL_KEY);
  });

  it("keeps folding in the single-pane layout", () => {
    const { projection } = open(input({ providers: [claude], profiles: null }));
    expect(projection.layout).toBe("singlePane");
    expect(modelIds(projection)).toEqual(claudeCurrent);
    expect(projection.pane.items.at(-1)).toMatchObject({ kind: "fold", count: 15 });
  });
});

describe("model picker search", () => {
  function search(query: string, overrides: Partial<ModelPickerInput<Profile>> = {}) {
    const pickerInput = input(overrides);
    const state = reduceModelPicker(createModelPickerState(pickerInput), { kind: "query", query });
    return projectModelPicker(pickerInput, state);
  }

  it("matches profiles and models across every provider, folded ones included", () => {
    const projection = search("5.4");
    expect(projection.pane.kind).toBe("search");
    expect(keys(projection.pane.items)).toEqual([
      "profile:deep-review",
      "model:codex:gpt-5.4",
      "model:codex:gpt-5.4-mini",
      "model:pi:openai/gpt-5.4",
    ]);
    expect(projection.activeKey).toBe("profile:deep-review");
  });

  it("tags models that browse would fold", () => {
    const projection = search("older-1");
    const tags = projection.pane.items.flatMap((item) => (item.kind === "model" ? [item.tag] : []));
    expect(tags.length).toBeGreaterThan(0);
    expect(new Set(tags)).toEqual(new Set(["older"]));
    const piFolded = search("gemini").pane.items[0];
    expect(piFolded).toMatchObject({ kind: "model", tag: "all" });
    const shown = search("gpt-5.4-mini").pane.items[0];
    expect(shown).toMatchObject({ kind: "model", tag: null });
  });

  it("ranks primary matches ahead of folded ones", () => {
    const opus: ProviderSelectorProvider = {
      id: "anthropic",
      label: "Anthropic",
      modelSelection: {
        kind: "models",
        rows: [
          row("anthropic", "Anthropic", "opus-5.5", { label: "Opus 5.5" }),
          row("anthropic", "Anthropic", "opus-4.6", { label: "Opus 4.6", legacy: true }),
          row("anthropic", "Anthropic", "opus-5", { label: "Opus 5", legacy: true }),
        ],
      },
    };
    const overrides = { providers: [opus], profiles: null };
    expect(keys(search("opus", overrides).pane.items)).toEqual([
      "model:anthropic:opus-5.5",
      "model:anthropic:opus-4.6",
      "model:anthropic:opus-5",
    ]);
    expect(keys(search("4.6", overrides).pane.items)).toEqual(["model:anthropic:opus-4.6"]);
  });

  it("ranks a close folded match ahead of a loose shown one", () => {
    const anthropic: ProviderSelectorProvider = {
      id: "anthropic",
      label: "Anthropic",
      modelSelection: {
        kind: "models",
        rows: [
          row("anthropic", "Anthropic", "opus-5.5", { label: "Opus 5.5" }),
          row("anthropic", "Anthropic", "opus-4.6", { label: "Opus 4.6", legacy: true }),
        ],
      },
    };
    // Nothing curated, so every row is shown, and "opus" only matches these scattered across
    // the id.
    const openrouter: ProviderSelectorProvider = {
      id: "openrouter",
      label: "OpenRouter",
      modelSelection: {
        kind: "models",
        rows: [
          row("openrouter", "OpenRouter", "openrouter/mistralai/codestral-2508", {
            label: "Codestral 2508",
          }),
          row("openrouter", "OpenRouter", "openrouter/anthropic/claude-sonnet-4.6", {
            label: "Claude Sonnet 4.6",
          }),
        ],
      },
    };
    const overrides = { providers: [openrouter, anthropic], profiles: null };
    expect(keys(search("opus", overrides).pane.items).slice(0, 2)).toEqual([
      "model:anthropic:opus-5.5",
      "model:anthropic:opus-4.6",
    ]);
    expect(keys(search("opus 4.6", overrides).pane.items)[0]).toBe("model:anthropic:opus-4.6");
  });

  it("searches only models when the surface shows no profiles", () => {
    expect(keys(search("deep review", { profiles: null }).pane.items)).toEqual([]);
  });

  it("reports no matches", () => {
    expect(search("zzzz").pane).toMatchObject({ kind: "noMatches", items: [] });
  });

  it("ignores surrounding whitespace and returns to browse when cleared", () => {
    expect(search("   ").pane.kind).toBe("provider");
  });
});

describe("model picker keyboard", () => {
  it("moves through the list with the arrow keys and wraps", () => {
    const pickerInput = input();
    let state = open(pickerInput).state;
    state = nextState(press(pickerInput, state, "ArrowDown"));
    expect(projectModelPicker(pickerInput, state).activeKey).toBe("model:claude:fable-5.2");
    state = nextState(press(pickerInput, state, "ArrowUp"));
    state = nextState(press(pickerInput, state, "ArrowUp"));
    expect(projectModelPicker(pickerInput, state).activeKey).toBe("fold:claude");
  });

  it("selects the active model on Enter", () => {
    const pickerInput = input();
    const state = nextState(press(pickerInput, open(pickerInput).state, "ArrowDown"));
    expect(press(pickerInput, state, "Enter")).toEqual({
      kind: "selectModel",
      provider: "claude",
      modelId: "fable-5.2",
    });
  });

  it("toggles the fold on Enter and keeps it active", () => {
    const pickerInput = input();
    const onFold = nextState(press(pickerInput, open(pickerInput).state, "ArrowUp"));
    const expanded = nextState(press(pickerInput, onFold, "Enter"));
    const projection = projectModelPicker(pickerInput, expanded);
    expect(modelIds(projection)).toHaveLength(19);
    expect(projection.activeKey).toBe("fold:claude");
  });

  it("moves to the rail with ArrowLeft and switches providers with the arrow keys", () => {
    const pickerInput = input();
    let state = nextState(press(pickerInput, open(pickerInput).state, "ArrowLeft"));
    let projection = projectModelPicker(pickerInput, state);
    expect(projection.focus).toBe("rail");
    expect(projection.activeKey).toBeNull();
    state = nextState(press(pickerInput, state, "ArrowDown"));
    projection = projectModelPicker(pickerInput, state);
    expect(projection.railKey).toBe("codex");
    expect(projection.pane).toMatchObject({ kind: "provider", providerId: "codex" });
    state = nextState(press(pickerInput, state, "ArrowRight"));
    projection = projectModelPicker(pickerInput, state);
    expect(projection.focus).toBe("list");
    expect(projection.activeKey).toBe("model:codex:gpt-5.4");
  });

  it("enters the list on Enter from the rail", () => {
    const pickerInput = input();
    const onRail = nextState(press(pickerInput, open(pickerInput).state, "ArrowLeft"));
    expect(
      projectModelPicker(pickerInput, nextState(press(pickerInput, onRail, "Enter"))).focus,
    ).toBe("list");
  });

  it("does not enter an empty pane from the rail", () => {
    const pickerInput = input();
    let state = reduceModelPicker(open(pickerInput).state, {
      kind: "selectRail",
      railKey: "copilot",
    });
    state = nextState(press(pickerInput, state, "ArrowLeft"));
    expect(press(pickerInput, state, "ArrowRight")).toBeNull();
  });

  it("leaves Left and Right to the caret while searching", () => {
    const pickerInput = input();
    const state = reduceModelPicker(open(pickerInput).state, { kind: "query", query: "gpt" });
    expect(press(pickerInput, state, "ArrowLeft")).toBeNull();
    expect(press(pickerInput, state, "ArrowRight")).toBeNull();
  });

  it("ignores Left and Right in the single-pane layout", () => {
    const pickerInput = input({ providers: [claude], profiles: null });
    expect(press(pickerInput, open(pickerInput).state, "ArrowLeft")).toBeNull();
  });

  it("applies a profile from search results on Enter", () => {
    const pickerInput = input();
    const state = reduceModelPicker(open(pickerInput).state, { kind: "query", query: "deep" });
    expect(press(pickerInput, state, "Enter")).toEqual({
      kind: "applyProfile",
      profileId: "deep-review",
    });
  });

  it("offers profile creation on Enter", () => {
    const pickerInput = input({ profiles: [], selectedProvider: "" });
    let state = reduceModelPicker(createModelPickerState(pickerInput), {
      kind: "selectRail",
      railKey: MODEL_PICKER_PROFILES_RAIL_KEY,
    });
    state = reduceModelPicker(state, { kind: "activate", key: "create-profile" });
    expect(press(pickerInput, state, "Enter")).toEqual({ kind: "createProfile" });
  });

  it("clears a search on Escape, then lets Escape close the picker", () => {
    const pickerInput = input();
    const searching = reduceModelPicker(open(pickerInput).state, { kind: "query", query: "gpt" });
    const cleared = nextState(press(pickerInput, searching, "Escape"));
    expect(cleared.query).toBe("");
    expect(projectModelPicker(pickerInput, cleared).pane.kind).toBe("provider");
    expect(press(pickerInput, cleared, "Escape")).toBeNull();
  });

  it("leaves Enter to a focused button and modified keys to the app", () => {
    const pickerInput = input();
    const { state } = open(pickerInput);
    expect(press(pickerInput, state, "Enter", { focusedControlOwnsEnter: true })).toBeNull();
    expect(press(pickerInput, state, "ArrowDown", { metaKey: true })).toBeNull();
  });
});
