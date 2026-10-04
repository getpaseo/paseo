import { describe, expect, it } from "vitest";
import type { AgentMode } from "@getpaseo/protocol/agent-types";
import {
  resolveAgentControlsMode,
  resolveAgentModeCycleStep,
  resolveNextAgentModeId,
} from "./mode";

const PLAN_MODE = { id: "plan", label: "Plan" } satisfies AgentMode;

const MODES = [
  PLAN_MODE,
  { id: "build", label: "Build" },
  { id: "full-access", label: "Full Access" },
] satisfies AgentMode[];

describe("resolveAgentControlsMode", () => {
  it("uses ready mode when no controlled agent controls are provided", () => {
    expect(resolveAgentControlsMode(undefined)).toBe("ready");
  });

  it("uses draft mode when controlled agent controls are provided", () => {
    expect(
      resolveAgentControlsMode({
        providerDefinitions: [],
        selectedProvider: "codex",
        modeOptions: [],
        selectedMode: "",
        onSelectMode: () => undefined,
        models: [],
        selectedModel: "",
        onSelectModel: () => undefined,
        isModelLoading: false,
        modelSelectorProviders: [],
        isAllModelsLoading: false,
        onSelectProviderAndModel: () => undefined,
        thinkingOptions: [],
        selectedThinkingOptionId: "",
        onSelectThinkingOption: () => undefined,
        onApplyAgentProfile: () => undefined,
      }),
    ).toBe("draft");
  });
});

describe("resolveNextAgentModeId", () => {
  it("cycles from the selected mode to the next mode", () => {
    expect(resolveNextAgentModeId({ modeOptions: MODES, selectedMode: "build" })).toBe(
      "full-access",
    );
  });

  it("wraps from the last mode to the first mode", () => {
    expect(resolveNextAgentModeId({ modeOptions: MODES, selectedMode: "full-access" })).toBe(
      "plan",
    );
  });

  it("treats an empty selection as the visible first mode", () => {
    expect(resolveNextAgentModeId({ modeOptions: MODES, selectedMode: "" })).toBe("build");
  });

  it("treats a stale selection as the visible first mode", () => {
    expect(resolveNextAgentModeId({ modeOptions: MODES, selectedMode: "deleted-mode" })).toBe(
      "build",
    );
  });

  it("returns null when there are fewer than two modes", () => {
    expect(resolveNextAgentModeId({ modeOptions: [], selectedMode: "" })).toBeNull();
    expect(resolveNextAgentModeId({ modeOptions: [PLAN_MODE], selectedMode: "plan" })).toBeNull();
  });
});

describe("resolveAgentModeCycleStep", () => {
  const CLAUDE_MODES = [
    { id: "plan", label: "Plan Mode", colorTier: "planning" },
    { id: "default", label: "Always Ask", colorTier: "safe" },
    { id: "acceptEdits", label: "Accept File Edits", colorTier: "moderate" },
    { id: "bypassPermissions", label: "Bypass", colorTier: "dangerous" },
  ] satisfies AgentMode[];
  const CODEX_MODES = [
    { id: "auto", label: "Default Permissions" },
    { id: "full-access", label: "Full Access", colorTier: "dangerous" },
  ] satisfies AgentMode[];

  it("reaches Plan from Bypass by turning the toggle on and keeping Bypass", () => {
    expect(
      resolveAgentModeCycleStep({
        modeOptions: CLAUDE_MODES,
        selectedMode: "bypassPermissions",
        planEnabled: false,
      }),
    ).toEqual({ kind: "plan-on" });
  });

  it("moves between access modes while Plan is off", () => {
    expect(
      resolveAgentModeCycleStep({
        modeOptions: CLAUDE_MODES,
        selectedMode: "default",
        planEnabled: false,
      }),
    ).toEqual({ kind: "mode", modeId: "acceptEdits" });
  });

  it("leaves Plan for the mode after the Plan stop", () => {
    expect(
      resolveAgentModeCycleStep({
        modeOptions: CLAUDE_MODES,
        selectedMode: "bypassPermissions",
        planEnabled: true,
      }),
    ).toEqual({ kind: "plan-off", modeId: "default" });
    expect(
      resolveAgentModeCycleStep({
        modeOptions: CLAUDE_MODES,
        selectedMode: "plan",
        planEnabled: true,
      }),
    ).toEqual({ kind: "plan-off", modeId: "default" });
  });

  it("keeps cycling modes for a provider whose Plan toggle has no Plan stop", () => {
    expect(
      resolveAgentModeCycleStep({
        modeOptions: CODEX_MODES,
        selectedMode: "full-access",
        planEnabled: true,
      }),
    ).toEqual({ kind: "mode", modeId: "auto" });
  });

  it("selects a planning mode for a provider without a Plan toggle", () => {
    expect(
      resolveAgentModeCycleStep({
        modeOptions: MODES,
        selectedMode: "full-access",
        planEnabled: null,
      }),
    ).toEqual({ kind: "mode", modeId: "plan" });
  });

  it("returns null when there is nothing to cycle", () => {
    expect(
      resolveAgentModeCycleStep({ modeOptions: [], selectedMode: "", planEnabled: null }),
    ).toBeNull();
  });
});
