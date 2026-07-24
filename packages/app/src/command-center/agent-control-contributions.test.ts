import { describe, expect, it } from "vitest";
import type { AgentFeature, AgentMode, AgentSelectOption } from "@getpaseo/protocol/agent-types";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";
import type { CommandCenterContribution } from "./contributions";
import {
  buildAgentControlContributions,
  type AgentControlContributionSource,
} from "./agent-control-contributions";

function TestIcon() {
  return null;
}

const LABELS: AgentControlContributionSource["labels"] = {
  model: "Model",
  thinking: "Thinking",
  mode: "Mode",
  planMode: "Plan mode",
  fast: "Fast",
  on: "On",
  off: "Off",
  modelKeywords: "model switch",
  thinkingKeywords: "reasoning effort",
  modeKeywords: "access permission",
  planKeywords: "plan planning",
  fastKeywords: "fast speed",
};

const ICONS: AgentControlContributionSource["icons"] = {
  provider: () => TestIcon,
  thinking: TestIcon,
  planMode: TestIcon,
  mode: () => TestIcon,
  feature: () => TestIcon,
};

function provider(input: {
  id: string;
  label: string;
  state?: "models" | "error";
}): ProviderSelectorProvider {
  if (input.state === "error") {
    return {
      id: input.id,
      label: input.label,
      modelSelection: { kind: "error", message: "Unavailable" },
    };
  }
  return {
    id: input.id,
    label: input.label,
    modelSelection: {
      kind: "models",
      rows: [
        {
          favoriteKey: `${input.id}:shared`,
          provider: input.id,
          providerLabel: input.label,
          modelId: "shared",
          modelLabel: `${input.label} model`,
          description: undefined,
        },
      ],
    },
  };
}

function toggleFeature(id: string, value = false, icon?: string): AgentFeature {
  return { type: "toggle", id, label: id, value, icon };
}

function makeSource(
  overrides: {
    provider?: string | null;
    models?: Partial<AgentControlContributionSource["models"]>;
    thinking?: Partial<AgentControlContributionSource["thinking"]>;
    modes?: Partial<AgentControlContributionSource["modes"]>;
    features?: Partial<AgentControlContributionSource["features"]>;
  } = {},
): AgentControlContributionSource {
  return {
    serverId: "host",
    ownerKey: "agent",
    provider: overrides.provider === undefined ? "claude" : overrides.provider,
    labels: LABELS,
    icons: ICONS,
    models: {
      providers: [],
      selectedProvider: null,
      selectedModelId: null,
      select: () => undefined,
      ...overrides.models,
    },
    thinking: {
      options: [],
      selectedId: null,
      select: () => undefined,
      ...overrides.thinking,
    },
    modes: {
      options: [],
      selectedId: null,
      defaultModeId: null,
      select: () => undefined,
      ...overrides.modes,
    },
    features: {
      list: [],
      set: () => undefined,
      ...overrides.features,
    },
  };
}

function selected(contribution: CommandCenterContribution): boolean {
  return contribution.presentation.kind === "choice" ? contribution.presentation.selected : false;
}

const THINKING_OPTIONS: AgentSelectOption[] = [
  { id: "low", label: "Low" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra High" },
];

const CLAUDE_MODES: AgentMode[] = [
  { id: "plan", label: "Plan Mode" },
  { id: "default", label: "Always Ask" },
  { id: "acceptEdits", label: "Accept File Edits" },
];

describe("Command Center agent-control contributions", () => {
  it("builds unique cross-provider model choices and skips unavailable or empty models", () => {
    const selections: string[] = [];
    const contributions = buildAgentControlContributions(
      makeSource({
        provider: null,
        models: {
          providers: [
            provider({ id: "claude", label: "Claude" }),
            provider({ id: "codex", label: "Codex" }),
            provider({ id: "unavailable", label: "Unavailable", state: "error" }),
            {
              id: "empty",
              label: "Empty",
              modelSelection: {
                kind: "models",
                rows: [
                  {
                    favoriteKey: "empty:",
                    provider: "empty",
                    providerLabel: "Empty",
                    modelId: "",
                    modelLabel: "Default",
                    description: undefined,
                  },
                ],
              },
            },
          ],
          selectedProvider: "codex",
          selectedModelId: "shared",
          select: (selectedProvider, modelId) => {
            selections.push(`${selectedProvider}:${modelId}`);
          },
        },
      }),
    );

    expect(
      contributions.map((contribution) => ({
        id: contribution.id,
        selected: selected(contribution),
      })),
    ).toEqual([
      { id: "models:claude:shared", selected: false },
      { id: "models:codex:shared", selected: true },
    ]);
    expect(contributions[0].presentation).toMatchObject({
      path: ["Model", "Claude", "Claude model"],
      testId: "command-center-model-host:claude:shared",
    });

    contributions[0].run();
    contributions[1].run();
    expect(selections).toEqual(["claude:shared"]);
  });

  it("publishes thinking choices only when selection is meaningful", () => {
    const selections: string[] = [];
    const contributions = buildAgentControlContributions(
      makeSource({
        thinking: {
          options: THINKING_OPTIONS,
          selectedId: "high",
          select: (id) => {
            selections.push(id);
          },
        },
      }),
    ).filter((contribution) => contribution.group === "thinking");

    expect(contributions.map((contribution) => contribution.id)).toEqual([
      "thinking:low",
      "thinking:high",
      "thinking:xhigh",
    ]);
    expect(contributions.map(selected)).toEqual([false, true, false]);
    for (const contribution of contributions) contribution.run();
    expect(selections).toEqual(["low", "xhigh"]);

    const singleOption = buildAgentControlContributions(
      makeSource({
        thinking: {
          options: [{ id: "high", label: "High" }],
          selectedId: "high",
        },
      }),
    );
    expect(singleOption.filter((contribution) => contribution.group === "thinking")).toEqual([]);
  });

  it("formats access modes, excludes planning modes, and marks the current mode", () => {
    const selections: string[] = [];
    const contributions = buildAgentControlContributions(
      makeSource({
        modes: {
          options: CLAUDE_MODES,
          selectedId: "default",
          defaultModeId: "default",
          select: (id) => {
            selections.push(id);
          },
        },
      }),
    ).filter((contribution) => contribution.group === "modes");

    expect(
      contributions.map((contribution) => ({
        id: contribution.id,
        path:
          contribution.presentation.kind === "choice" ? contribution.presentation.path : undefined,
        selected: selected(contribution),
      })),
    ).toEqual([
      { id: "modes:default", path: ["Mode", "Always ask"], selected: true },
      { id: "modes:acceptEdits", path: ["Mode", "Accept file edits"], selected: false },
    ]);
    contributions[1].run();
    expect(selections).toEqual(["acceptEdits"]);
  });

  it("toggles mode-based Plan through the plan mode and provider default", () => {
    const selections: string[] = [];
    const contributions = buildAgentControlContributions(
      makeSource({
        modes: {
          options: CLAUDE_MODES,
          selectedId: "plan",
          defaultModeId: "default",
          select: (id) => {
            selections.push(id);
          },
        },
      }),
    ).filter((contribution) => contribution.group === "plan-mode");

    expect(
      contributions.map((contribution) => ({
        id: contribution.id,
        selected: selected(contribution),
      })),
    ).toEqual([
      { id: "plan-mode:on", selected: true },
      { id: "plan-mode:off", selected: false },
    ]);
    contributions[1].run();
    expect(selections).toEqual(["default"]);
  });

  it("does not use a planning provider default as the Plan off target", () => {
    const selections: string[] = [];
    const contributions = buildAgentControlContributions(
      makeSource({
        modes: {
          options: [
            { id: "research", label: "Research", colorTier: "planning" },
            { id: "default", label: "Default", colorTier: "safe" },
          ],
          selectedId: "research",
          defaultModeId: "research",
          select: (id) => {
            selections.push(id);
          },
        },
      }),
    ).filter((contribution) => contribution.group === "plan-mode");

    contributions[1].run();
    expect(selections).toEqual(["default"]);
  });

  it("prefers the plan_mode feature and reads its canonical value", () => {
    const calls: [string, unknown][] = [];
    const contributions = buildAgentControlContributions(
      makeSource({
        modes: {
          options: CLAUDE_MODES,
          selectedId: "default",
          defaultModeId: "default",
        },
        features: {
          list: [toggleFeature("plan_mode", true, "list-todo")],
          set: (id, value) => {
            calls.push([id, value]);
          },
        },
      }),
    ).filter((contribution) => contribution.group === "plan-mode");

    expect(contributions.map(selected)).toEqual([true, false]);
    contributions[1].run();
    expect(calls).toEqual([["plan_mode", false]]);
  });

  it("publishes Fast only for an available toggle and ignores unrelated features", () => {
    const calls: [string, unknown][] = [];
    const contributions = buildAgentControlContributions(
      makeSource({
        features: {
          list: [toggleFeature("fast_mode", false, "zap"), toggleFeature("auto_accept", true)],
          set: (id, value) => {
            calls.push([id, value]);
          },
        },
      }),
    );
    const fast = contributions.filter((contribution) => contribution.group === "fast-mode");

    expect(fast.map(selected)).toEqual([false, true]);
    expect(contributions.some((contribution) => contribution.id.includes("auto_accept"))).toBe(
      false,
    );
    fast[0].run();
    expect(calls).toEqual([["fast_mode", true]]);

    const unavailable = buildAgentControlContributions(makeSource());
    expect(unavailable.filter((contribution) => contribution.group === "fast-mode")).toEqual([]);
  });

  it("centralizes query-only group ordering between built-in result sections", () => {
    const contributions = buildAgentControlContributions(
      makeSource({
        models: {
          providers: [provider({ id: "claude", label: "Claude" })],
          selectedProvider: "claude",
          selectedModelId: "shared",
        },
        thinking: { options: THINKING_OPTIONS, selectedId: "high" },
        modes: {
          options: CLAUDE_MODES,
          selectedId: "default",
          defaultModeId: "default",
        },
        features: { list: [toggleFeature("fast_mode")] },
      }),
    );
    const ranks = new Map<string, number>();
    for (const contribution of contributions) {
      ranks.set(contribution.group, contribution.groupRank);
      expect(contribution.visibility).toBe("query");
    }

    expect([...ranks.entries()]).toEqual([
      ["models", 1],
      ["thinking", 1.1],
      ["modes", 1.2],
      ["plan-mode", 1.3],
      ["fast-mode", 1.4],
    ]);
    for (const rank of ranks.values()) expect(rank).toBeLessThan(2);
    expect(new Set(contributions.map((contribution) => contribution.id)).size).toBe(
      contributions.length,
    );
  });
});
