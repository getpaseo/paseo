import type { AgentInfo, ModelInfo } from "@opencode-ai/client";
import { describe, expect, test } from "vitest";

import type { AgentMode } from "../../agent-sdk-types.js";
import {
  filterOpenCodeV2ModelInfosByCredentials,
  isSelectableOpenCodeV2Agent,
  mapOpenCodeV2AgentToMode,
  mapOpenCodeV2ModelToDefinition,
  sortOpenCodeV2Modes,
} from "./catalog.js";

function buildModelInfo(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: "deepseek-ai/DeepSeek-V4-Flash-0731",
    modelID: "deepseek-ai/DeepSeek-V4-Flash-0731",
    providerID: "baseten",
    name: "DeepSeek V4 Flash 0731",
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [],
    time: { released: 0 },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    status: "active",
    enabled: true,
    limit: { context: 1_000_000, output: 131_072 },
    ...overrides,
  };
}

function buildAgentInfo(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: "build",
    name: "build",
    mode: "primary",
    hidden: false,
    request: { settings: {}, headers: {}, body: {} },
    permissions: [],
    ...overrides,
  };
}

describe("opencode-v2 catalog mapping", () => {
  test("maps a model to a paseo definition with providerID/modelID id", () => {
    const definition = mapOpenCodeV2ModelToDefinition(buildModelInfo());
    expect(definition).toMatchObject({
      provider: "opencode-v2",
      id: "baseten/deepseek-ai/DeepSeek-V4-Flash-0731",
      label: "DeepSeek V4 Flash 0731",
      contextWindowMaxTokens: 1_000_000,
    });
  });

  test("surfaces variants as thinking options with a default", () => {
    const definition = mapOpenCodeV2ModelToDefinition(
      buildModelInfo({
        variants: [{ id: "low" }, { id: "high" }, { id: "max" }],
      }),
    );
    expect(definition.thinkingOptions).toEqual([
      { id: "default", label: "Default", isDefault: true },
      { id: "low", label: "low" },
      { id: "high", label: "high" },
      { id: "max", label: "max" },
    ]);
    expect(definition.defaultThinkingOptionId).toBe("default");
  });

  test("omits thinking options for models without variants", () => {
    const definition = mapOpenCodeV2ModelToDefinition(buildModelInfo());
    expect(definition.thinkingOptions).toBeUndefined();
    expect(definition.defaultThinkingOptionId).toBeUndefined();
  });

  test("maps metadata including cost, limit, and capability flags", () => {
    const definition = mapOpenCodeV2ModelToDefinition(
      buildModelInfo({
        capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
        compatibility: { reasoningField: "reasoning_content" },
        cost: [{ input: 1.32, output: 3.96, cache: { read: 0, write: 0 } }],
        limit: { context: 1_048_576, output: 262_144 },
      }),
    );
    expect(definition.metadata).toMatchObject({
      providerId: "baseten",
      modelId: "deepseek-ai/DeepSeek-V4-Flash-0731",
      supportsAttachments: true,
      supportsReasoning: true,
      supportsToolCall: true,
      contextWindowMaxTokens: 1_048_576,
    });
  });

  test("filters models to credentialed providers plus the free opencode provider", () => {
    const models = [
      buildModelInfo({ providerID: "baseten", modelID: "deepseek-ai/DeepSeek-V4-Flash-0731" }),
      buildModelInfo({ providerID: "openai", modelID: "gpt-5.5" }),
      buildModelInfo({ providerID: "meta", modelID: "muse-spark-1.2" }),
      buildModelInfo({ providerID: "opencode", modelID: "x-preview-f-free" }),
    ];
    const filtered = filterOpenCodeV2ModelInfosByCredentials(
      models,
      new Set(["baseten", "openai"]),
    );
    expect(filtered.map((model) => model.providerID)).toEqual(["baseten", "openai", "opencode"]);
  });

  test("keeps only the free opencode provider when no credentials exist", () => {
    const models = [
      buildModelInfo({ providerID: "baseten", modelID: "deepseek-ai/DeepSeek-V4-Flash-0731" }),
      buildModelInfo({ providerID: "opencode", modelID: "x-preview-f-free" }),
    ];
    const filtered = filterOpenCodeV2ModelInfosByCredentials(models, new Set());
    expect(filtered.map((model) => model.providerID)).toEqual(["opencode"]);
  });

  test("maps an agent to a mode and filters hidden agents", () => {
    expect(isSelectableOpenCodeV2Agent(buildAgentInfo())).toBe(true);
    expect(isSelectableOpenCodeV2Agent(buildAgentInfo({ hidden: true }))).toBe(false);

    const mode = mapOpenCodeV2AgentToMode(buildAgentInfo({ description: "Implementation work" }));
    expect(mode).toMatchObject({
      id: "build",
      label: "Build",
      icon: "Bot",
      description: "Implementation work",
    });
  });

  test("normalizes capitalized v2 agent ids to lowercase mode ids", () => {
    const mode = mapOpenCodeV2AgentToMode(
      buildAgentInfo({ id: "Plan", name: "Plan", description: "Read-only planning" }),
    );
    expect(mode.id).toBe("plan");
    expect(mode.label).toBe("Plan");
  });

  test("sorts build and plan first then the rest alphabetically", () => {
    const modes: AgentMode[] = [
      { id: "general", label: "General" },
      { id: "plan", label: "Plan" },
      { id: "build", label: "Build" },
      { id: "explore", label: "Explore" },
    ];
    expect(sortOpenCodeV2Modes(modes).map((mode) => mode.id)).toEqual([
      "build",
      "plan",
      "explore",
      "general",
    ]);
  });
});
