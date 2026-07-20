import { describe, expect, it } from "vitest";
import type { AgentFeature, AgentMode, AgentSelectOption } from "@getpaseo/protocol/agent-types";
import type { CommandCenterContribution } from "./contributions";
import {
  buildAgentSettingContributions,
  isPlanMode,
  type AgentSettingsSource,
} from "./agent-setting-contributions";

function TestIcon() {
  return null;
}

const LABELS: AgentSettingsSource["labels"] = {
  thinking: "Thinking",
  mode: "Mode",
  planMode: "Plan mode",
  fast: "Fast",
  on: "On",
  off: "Off",
  thinkingKeywords: "reasoning effort",
  modeKeywords: "access permission",
  planKeywords: "plan planning",
  fastKeywords: "fast speed",
};

const ICONS: AgentSettingsSource["icons"] = {
  thinking: TestIcon,
  planMode: TestIcon,
  fast: TestIcon,
  mode: () => TestIcon,
};

function toggleFeature(id: string): AgentFeature {
  return { type: "toggle", id, label: id, value: false };
}

function makeSource(overrides: {
  provider?: string | null;
  thinking?: Partial<AgentSettingsSource["thinking"]>;
  modes?: Partial<AgentSettingsSource["modes"]>;
  features?: Partial<AgentSettingsSource["features"]>;
}): AgentSettingsSource {
  return {
    serverId: "host",
    ownerKey: "agent",
    provider: overrides.provider === undefined ? "claude" : overrides.provider,
    labels: LABELS,
    icons: ICONS,
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
      value: () => undefined,
      set: () => undefined,
      ...overrides.features,
    },
  };
}

function selectionOf(contribution: CommandCenterContribution): boolean {
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

describe("isPlanMode", () => {
  it("matches plain and ACP-style plan ids only", () => {
    expect(isPlanMode("plan")).toBe(true);
    expect(isPlanMode("https://agentclientprotocol.com/protocol/session-modes#plan")).toBe(true);
    expect(isPlanMode("default")).toBe(false);
    expect(isPlanMode("acceptEdits")).toBe(false);
  });
});

describe("buildAgentSettingContributions — thinking", () => {
  it("emits a selectable row per option and runs select for non-selected rows", () => {
    const selected: string[] = [];
    const contributions = buildAgentSettingContributions(
      makeSource({
        thinking: {
          options: THINKING_OPTIONS,
          selectedId: "high",
          select: (id) => selected.push(id),
        },
      }),
    ).filter((c) => c.group === "thinking");

    expect(contributions.map((c) => ({ id: c.id, selected: selectionOf(c) }))).toEqual([
      { id: "host:agent:thinking:low", selected: false },
      { id: "host:agent:thinking:high", selected: true },
      { id: "host:agent:thinking:xhigh", selected: false },
    ]);

    for (const c of contributions) c.run();
    // The already-selected "high" row is a no-op.
    expect(selected).toEqual(["low", "xhigh"]);
  });

  it("suppresses the thinking group when there is one or zero options", () => {
    const contributions = buildAgentSettingContributions(
      makeSource({ thinking: { options: [{ id: "high", label: "High" }], selectedId: "high" } }),
    );
    expect(contributions.filter((c) => c.group === "thinking")).toEqual([]);
  });
});

describe("buildAgentSettingContributions — access mode", () => {
  it("lists modes excluding plan and marks the current one", () => {
    const selected: string[] = [];
    const contributions = buildAgentSettingContributions(
      makeSource({
        modes: {
          options: CLAUDE_MODES,
          selectedId: "default",
          defaultModeId: "default",
          select: (id) => selected.push(id),
        },
      }),
    ).filter((c) => c.group === "modes");

    expect(contributions.map((c) => c.id)).toEqual([
      "host:agent:mode:default",
      "host:agent:mode:acceptEdits",
    ]);
    expect(contributions.map(selectionOf)).toEqual([true, false]);

    contributions[1].run();
    expect(selected).toEqual(["acceptEdits"]);
  });
});

describe("buildAgentSettingContributions — plan mode (mode-based)", () => {
  it("toggles between the plan mode and the default mode", () => {
    const selected: string[] = [];
    const contributions = buildAgentSettingContributions(
      makeSource({
        modes: {
          options: CLAUDE_MODES,
          selectedId: "plan",
          defaultModeId: "default",
          select: (id) => selected.push(id),
        },
      }),
    ).filter((c) => c.group === "plan-mode");

    // On is selected because current mode is plan.
    expect(contributions.map((c) => ({ id: c.id, selected: selectionOf(c) }))).toEqual([
      { id: "host:agent:plan:on", selected: true },
      { id: "host:agent:plan:off", selected: false },
    ]);

    contributions[1].run(); // Off -> default
    expect(selected).toEqual(["default"]);
  });

  it("turns plan on by selecting the plan mode", () => {
    const selected: string[] = [];
    const onRow = buildAgentSettingContributions(
      makeSource({
        modes: {
          options: CLAUDE_MODES,
          selectedId: "default",
          defaultModeId: "default",
          select: (id) => selected.push(id),
        },
      }),
    ).find((contribution) => contribution.id === "host:agent:plan:on");

    onRow?.run(); // On -> plan
    expect(selected).toEqual(["plan"]);
  });

  it("is absent when the provider has no plan mode or plan feature", () => {
    const contributions = buildAgentSettingContributions(
      makeSource({
        modes: {
          options: [
            { id: "auto", label: "Default Permissions" },
            { id: "full-access", label: "Full Access" },
          ],
          selectedId: "auto",
          defaultModeId: "auto",
        },
      }),
    );
    expect(contributions.filter((c) => c.group === "plan-mode")).toEqual([]);
  });
});

describe("buildAgentSettingContributions — plan mode (feature-based / Codex)", () => {
  it("drives the plan_mode feature and prefers it over any plan mode", () => {
    const calls: [string, unknown][] = [];
    const contributions = buildAgentSettingContributions(
      makeSource({
        provider: "codex",
        features: {
          list: [toggleFeature("plan_mode")],
          value: (id) => (id === "plan_mode" ? true : undefined),
          set: (id, value) => calls.push([id, value]),
        },
      }),
    ).filter((c) => c.group === "plan-mode");

    expect(contributions.map(selectionOf)).toEqual([true, false]); // On selected

    contributions[1].run(); // Off
    expect(calls).toEqual([["plan_mode", false]]);
  });
});

describe("buildAgentSettingContributions — fast mode", () => {
  it("appears only when the fast_mode feature is available and drives it", () => {
    const calls: [string, unknown][] = [];
    const contributions = buildAgentSettingContributions(
      makeSource({
        features: {
          list: [toggleFeature("fast_mode")],
          value: (id) => (id === "fast_mode" ? false : undefined),
          set: (id, value) => calls.push([id, value]),
        },
      }),
    ).filter((c) => c.group === "fast-mode");

    expect(contributions.map((c) => ({ id: c.id, selected: selectionOf(c) }))).toEqual([
      { id: "host:agent:fast:on", selected: false },
      { id: "host:agent:fast:off", selected: true },
    ]);

    contributions[0].run(); // On
    expect(calls).toEqual([["fast_mode", true]]);
  });

  it("is absent when the fast_mode feature is not offered", () => {
    const contributions = buildAgentSettingContributions(makeSource({}));
    expect(contributions.filter((c) => c.group === "fast-mode")).toEqual([]);
  });
});

describe("buildAgentSettingContributions — section ordering", () => {
  it("ranks every agent-setting group between models (1) and workspaces (2)", () => {
    const contributions = buildAgentSettingContributions(
      makeSource({
        thinking: { options: THINKING_OPTIONS, selectedId: "high" },
        modes: { options: CLAUDE_MODES, selectedId: "default", defaultModeId: "default" },
        features: {
          list: [toggleFeature("fast_mode")],
          value: () => false,
          set: () => undefined,
        },
      }),
    );
    const ranks = new Map<string, number>();
    for (const contribution of contributions) ranks.set(contribution.group, contribution.groupRank);

    // Clustered strictly between the model rows (1) and the built-in Workspaces (2).
    for (const rank of ranks.values()) {
      expect(rank).toBeGreaterThan(1);
      expect(rank).toBeLessThan(2);
    }
    // Ordered thinking < mode < plan < fast.
    expect(ranks.get("thinking")).toBeLessThan(ranks.get("modes") ?? 0);
    expect(ranks.get("modes")).toBeLessThan(ranks.get("plan-mode") ?? 0);
    expect(ranks.get("plan-mode")).toBeLessThan(ranks.get("fast-mode") ?? 0);
  });
});

describe("buildAgentSettingContributions — provider gating", () => {
  it("returns nothing when no provider is resolved", () => {
    expect(
      buildAgentSettingContributions(
        makeSource({ provider: null, thinking: { options: THINKING_OPTIONS, selectedId: "high" } }),
      ),
    ).toEqual([]);
  });
});
