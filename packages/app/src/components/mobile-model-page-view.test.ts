import { describe, expect, it } from "vitest";
import { MODEL_PICKER_PROFILES_RAIL_KEY } from "@/components/model-browser-panes-view";
import type { NavigableProfileRow } from "@/components/model-browser-view";
import type {
  ProviderSelectionModelRow,
  ProviderSelectorProvider,
} from "@/provider-selection/provider-selection";
import {
  createMobileModelPageState,
  projectMobileModelPage,
  reduceMobileModelPage,
  type MobileModelPageInput,
  type MobileModelPageProjection,
} from "./mobile-model-page-view";

function row(
  providerId: string,
  providerLabel: string,
  modelId: string,
  options: { legacy?: boolean } = {},
): ProviderSelectionModelRow {
  return {
    favoriteKey: `${providerId}:${modelId}`,
    provider: providerId,
    providerLabel,
    modelId,
    modelLabel: modelId,
    ...(options.legacy ? { legacy: true } : {}),
  };
}

const profile = (
  id: string,
  name: string,
  summary: string,
  provider: string,
): NavigableProfileRow => ({
  id,
  name,
  summary,
  provider,
});
const reviewer = profile("reviewer", "Reviewer", "Claude · Opus 5.5 · Plan", "claude");
const fixer = profile("fixer", "Bug fixer", "Codex · GPT-5.4", "codex");

const claudeOlder = Array.from({ length: 15 }, (_, index) => `claude-older-${index + 1}`);
const claude: ProviderSelectorProvider = {
  id: "claude",
  label: "Claude",
  modelSelection: {
    kind: "models",
    rows: [
      ...["opus-5.5", "fable-5.2", "sonnet-5.5", "haiku-5.5"].map((id) =>
        row("claude", "Claude", id),
      ),
      ...claudeOlder.map((id) => row("claude", "Claude", id, { legacy: true })),
    ],
  },
};
const copilot: ProviderSelectorProvider = {
  id: "copilot",
  label: "Copilot",
  modelSelection: { kind: "error", message: "Not signed in" },
};
const codex: ProviderSelectorProvider = {
  id: "codex",
  label: "Codex",
  modelSelection: {
    kind: "models",
    rows: [row("codex", "Codex", "gpt-5.4"), row("codex", "Codex", "gpt-5.4-mini")],
  },
};
const opencode: ProviderSelectorProvider = {
  id: "opencode",
  label: "OpenCode",
  modelSelection: { kind: "loading" },
};
const pi: ProviderSelectorProvider = {
  id: "pi",
  label: "Pi",
  shownModels: ["anthropic/opus-5.5", "openai/gpt-5.4"],
  modelSelection: {
    kind: "models",
    rows: [
      row("pi", "Pi", "anthropic/opus-5.5"),
      row("pi", "Pi", "openai/gpt-5.4"),
      row("pi", "Pi", "openai/gpt-5.4-mini"),
      row("pi", "Pi", "anthropic/opus-4.6"),
    ],
  },
};

const input: MobileModelPageInput = {
  providers: [claude, copilot, codex, opencode, pi],
  profiles: null,
  canCreateProfile: false,
  selectedProvider: "claude",
  selectedModel: "opus-5.5",
};

const inputWithProfiles: MobileModelPageInput = {
  ...input,
  profiles: [reviewer, fixer],
  canCreateProfile: true,
};

function project(
  actions: Parameters<typeof reduceMobileModelPage>[1][] = [],
  pageInput: MobileModelPageInput = input,
): MobileModelPageProjection {
  const state = actions.reduce(reduceMobileModelPage, createMobileModelPageState(pageInput));
  return projectMobileModelPage(pageInput, state);
}

function browse(projection: MobileModelPageProjection) {
  if (projection.kind !== "browse") throw new Error(`expected browse, got ${projection.kind}`);
  return projection;
}

function bodyKeys(projection: MobileModelPageProjection): string[] {
  const { body } = browse(projection);
  if (!body) throw new Error("expected an expanded section body, got null");
  return body.items.map((item) => item.key);
}

describe("mobile model page", () => {
  it("opens with the selected provider expanded and the others as rows, errors last", () => {
    const projection = browse(project());
    expect(projection.showSectionHeaders).toBe(true);
    expect(
      projection.sections.map((section) =>
        section.kind === "provider"
          ? {
              providerId: section.providerId,
              status: section.status,
              expanded: section.expanded,
              shown: section.shown,
              total: section.total,
            }
          : section,
      ),
    ).toEqual([
      { providerId: "claude", status: "ready", expanded: true, shown: 4, total: 19 },
      { providerId: "codex", status: "ready", expanded: false, shown: 2, total: 2 },
      { providerId: "opencode", status: "loading", expanded: false, shown: 0, total: 0 },
      { providerId: "pi", status: "ready", expanded: false, shown: 2, total: 4 },
      { providerId: "copilot", status: "error", expanded: false, shown: 0, total: 0 },
    ]);
  });

  it("places Profiles as the first collapsible category when the surface offers profiles", () => {
    const projection = browse(project([], inputWithProfiles));
    expect(projection.showSectionHeaders).toBe(true);
    expect(projection.sections[0]).toEqual({
      kind: "profiles",
      key: MODEL_PICKER_PROFILES_RAIL_KEY,
      count: 2,
      expanded: false,
    });
    expect(projection.sections.find((section) => section.expanded)?.key).toBe("claude");
  });

  it("expands Profiles to list saved profiles, or Create profile when there are none", () => {
    const expanded = browse(
      project([{ kind: "toggleSection", key: MODEL_PICKER_PROFILES_RAIL_KEY }], inputWithProfiles),
    );
    expect(expanded.sections.filter((section) => section.expanded)).toMatchObject([
      { kind: "profiles", key: MODEL_PICKER_PROFILES_RAIL_KEY },
    ]);
    expect(expanded.body).toEqual({
      kind: "profiles",
      items: [
        { kind: "profile", key: "profile:reviewer", profile: reviewer },
        { kind: "profile", key: "profile:fixer", profile: fixer },
      ],
    });

    const emptyCreate = browse(
      project([{ kind: "toggleSection", key: MODEL_PICKER_PROFILES_RAIL_KEY }], {
        ...inputWithProfiles,
        profiles: [],
        canCreateProfile: true,
      }),
    );
    expect(emptyCreate.body).toEqual({
      kind: "profiles",
      items: [{ kind: "createProfile", key: "create-profile" }],
    });
  });

  it("collapses the open section when tapped again so every group can be collapsed", () => {
    const collapsedProvider = browse(
      project([{ kind: "toggleSection", key: "claude" }], inputWithProfiles),
    );
    expect(collapsedProvider.sections.every((section) => !section.expanded)).toBe(true);
    expect(collapsedProvider.body).toBeNull();
    expect(collapsedProvider.selectedIndex).toBeNull();

    const collapsedProfiles = browse(
      project(
        [
          { kind: "toggleSection", key: MODEL_PICKER_PROFILES_RAIL_KEY },
          { kind: "toggleSection", key: MODEL_PICKER_PROFILES_RAIL_KEY },
        ],
        inputWithProfiles,
      ),
    );
    expect(collapsedProfiles.sections.every((section) => !section.expanded)).toBe(true);
    expect(collapsedProfiles.body).toBeNull();
  });

  it("lists the expanded provider's shown models above a closed fold", () => {
    expect(bodyKeys(project())).toEqual([
      "model:claude:opus-5.5",
      "model:claude:fable-5.2",
      "model:claude:sonnet-5.5",
      "model:claude:haiku-5.5",
      "fold:claude",
    ]);
  });

  it("opens the fold to list the models behind it", () => {
    const keys = bodyKeys(project([{ kind: "toggleFold", providerId: "claude", expanded: true }]));
    expect(keys).toHaveLength(4 + 1 + 15);
    expect(keys[5]).toBe("model:claude:claude-older-1");
  });

  it("expands one section at a time", () => {
    const projection = browse(project([{ kind: "toggleSection", key: "pi" }]));
    expect(projection.sections.filter((section) => section.expanded)).toMatchObject([
      { kind: "provider", providerId: "pi" },
    ]);
    expect(bodyKeys(projection)).toEqual([
      "model:pi:anthropic/opus-5.5",
      "model:pi:openai/gpt-5.4",
      "fold:pi",
    ]);
  });

  it("opens the fold when the selected model sits behind it", () => {
    const keys = bodyKeys(
      project([], { ...input, selectedProvider: "claude", selectedModel: "claude-older-3" }),
    );
    expect(keys).toContain("model:claude:claude-older-3");
  });

  it("points the open list at the selected model, so a folded pick is in view on reopen", () => {
    const folded = browse(
      project([], { ...input, selectedProvider: "claude", selectedModel: "claude-older-3" }),
    );
    expect(
      folded.body?.kind === "provider" && folded.body.items[folded.selectedIndex ?? -1]?.key,
    ).toBe("model:claude:claude-older-3");
    expect(browse(project()).selectedIndex).toBe(0);
    expect(browse(project([{ kind: "toggleSection", key: "codex" }])).selectedIndex).toBeNull();
  });

  it("shows a loading or errored provider's state in its section", () => {
    expect(browse(project([{ kind: "toggleSection", key: "opencode" }])).body).toMatchObject({
      kind: "providerLoading",
      providerId: "opencode",
    });
    expect(browse(project([{ kind: "toggleSection", key: "copilot" }])).body).toMatchObject({
      kind: "providerError",
      providerId: "copilot",
      message: "Not signed in",
    });
  });

  it("expands the first ready provider when the selected one is not listed and there are no profiles", () => {
    const projection = browse(project([], { ...input, selectedProvider: "", selectedModel: "" }));
    expect(projection.sections.find((section) => section.expanded)?.key).toBe("claude");
  });

  it("lists a lone provider's models without section headers when profiles are absent, and with headers when profiles exist", () => {
    const loneWithoutProfiles = browse(
      project([], {
        providers: [codex],
        profiles: null,
        canCreateProfile: false,
        selectedProvider: "codex",
        selectedModel: "gpt-5.4",
      }),
    );
    expect(loneWithoutProfiles.showSectionHeaders).toBe(false);
    expect(bodyKeys(loneWithoutProfiles)).toEqual([
      "model:codex:gpt-5.4",
      "model:codex:gpt-5.4-mini",
    ]);

    const loneWithProfiles = browse(
      project([], {
        providers: [codex],
        profiles: [],
        canCreateProfile: true,
        selectedProvider: "codex",
        selectedModel: "gpt-5.4",
      }),
    );
    expect(loneWithProfiles.showSectionHeaders).toBe(true);
    expect(loneWithProfiles.sections.map((section) => section.key)).toEqual([
      MODEL_PICKER_PROFILES_RAIL_KEY,
      "codex",
    ]);
  });

  it("searches profiles and every provider, shown models before folded ones", () => {
    const projection = project([{ kind: "query", query: "opus" }], inputWithProfiles);
    expect(projection.kind).toBe("search");
    if (projection.kind !== "search") return;
    expect(projection.profiles.map((item) => item.key)).toEqual(["profile:reviewer"]);
    expect(
      projection.models.map((item) => (item.kind === "model" ? [item.key, item.tag] : [item.key])),
    ).toEqual([
      ["model:claude:opus-5.5", null],
      ["model:pi:anthropic/opus-5.5", null],
      ["model:pi:anthropic/opus-4.6", "all"],
    ]);
  });

  it("finds folded models that only match behind the fold", () => {
    const projection = project([{ kind: "query", query: "older-12" }]);
    expect(projection).toMatchObject({
      kind: "search",
      items: [{ key: "model:claude:claude-older-12", tag: "older" }],
    });
  });

  it("returns to the expanded or all-collapsed state when the search clears", () => {
    const expandedAgain = project([
      { kind: "toggleSection", key: "pi" },
      { kind: "query", query: "opus" },
      { kind: "query", query: "" },
    ]);
    expect(browse(expandedAgain).sections.find((section) => section.expanded)?.key).toBe("pi");

    const stillCollapsed = project([
      { kind: "toggleSection", key: "claude" },
      { kind: "query", query: "opus" },
      { kind: "query", query: "" },
    ]);
    expect(browse(stillCollapsed).body).toBeNull();
    expect(browse(stillCollapsed).sections.every((section) => !section.expanded)).toBe(true);
  });

  it("says when the host lists no providers, as it does before the first provider snapshot", () => {
    const empty: MobileModelPageInput = {
      providers: [],
      profiles: null,
      canCreateProfile: false,
      selectedProvider: "",
      selectedModel: "",
    };
    expect(project([], empty)).toEqual({ kind: "noProviders" });
    expect(project([{ kind: "query", query: "opus" }], empty)).toEqual({ kind: "noProviders" });
  });

  it("says when nothing matches", () => {
    expect(project([{ kind: "query", query: " zzz " }])).toEqual({
      kind: "noMatches",
      query: "zzz",
    });
  });
});
