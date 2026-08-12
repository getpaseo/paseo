import type {
  ClientSideConnection,
  SessionConfigOption,
  SessionModelState,
} from "@agentclientprotocol/sdk";
import { describe, expect, test, vi } from "vitest";

import type { AgentModelDefinition } from "../agent-sdk-types.js";
import type { ACPCatalogModelResolverContext } from "./acp-agent.js";
import {
  applyGrokReasoningOptions,
  resolveGrokCatalogModels,
  transformGrokSessionResponse,
  writeGrokModel,
  writeGrokThinkingOption,
} from "./grok-acp-agent.js";

const grokModelState = {
  currentModelId: "grok-4.6",
  availableModels: [
    {
      modelId: "grok-4.6",
      name: "Grok 4.6",
      _meta: {
        reasoningEffort: "high",
        reasoningEfforts: [
          {
            id: "xhigh",
            value: "xhigh",
            label: "Extra High Effort",
            default: true,
          },
          { id: "high", value: "high", label: "High Effort", default: true },
          { id: "medium", value: "medium", label: "Medium Effort", default: false },
          { id: "low", value: "low", label: "Low Effort", default: false },
        ],
      },
    },
    {
      modelId: "grok-4.5",
      name: "Grok 4.5",
      _meta: {
        reasoningEffort: "high",
        reasoningEfforts: [
          { id: "high", value: "high", label: "High Effort", default: true },
          { id: "medium", value: "medium", label: "Medium Effort", default: false },
          { id: "low", value: "low", label: "Low Effort", default: false },
        ],
      },
    },
  ],
} satisfies SessionModelState;

const grokReasoningConfigOption = {
  id: "_paseo.grok.reasoning_effort",
  name: "Reasoning effort",
  category: "thought_level",
  type: "select",
  currentValue: "high",
  options: [
    { value: "xhigh", name: "Extra High Effort" },
    { value: "high", name: "High Effort" },
    { value: "medium", name: "Medium Effort" },
    { value: "low", name: "Low Effort" },
  ],
} satisfies SessionConfigOption;

const standardThinkingConfigOption = {
  id: "reasoning",
  name: "Reasoning",
  category: "thought_level",
  type: "select",
  currentValue: "medium",
  options: [{ value: "medium", name: "Medium" }],
} satisfies SessionConfigOption;

describe("Grok ACP reasoning options", () => {
  test("keeps each model's effort levels separate and uses its reported current effort as default", () => {
    const models: AgentModelDefinition[] = [
      {
        provider: "acp",
        id: "grok-4.6",
        label: "Grok 4.6",
        isDefault: true,
      },
      {
        provider: "acp",
        id: "grok-4.5",
        label: "Grok 4.5",
        isDefault: false,
      },
    ];
    const result = applyGrokReasoningOptions(models, grokModelState);

    expect(result).toEqual([
      {
        ...models[0],
        thinkingOptions: [
          { id: "xhigh", label: "Extra High Effort", isDefault: false },
          { id: "high", label: "High Effort", isDefault: true },
          { id: "medium", label: "Medium Effort", isDefault: false },
          { id: "low", label: "Low Effort", isDefault: false },
        ],
        defaultThinkingOptionId: "high",
      },
      {
        ...models[1],
        thinkingOptions: [
          { id: "high", label: "High Effort", isDefault: true },
          { id: "medium", label: "Medium Effort", isDefault: false },
          { id: "low", label: "Low Effort", isDefault: false },
        ],
        defaultThinkingOptionId: "high",
      },
    ]);
  });

  test("maps the current model's actual effort into session thinking state", () => {
    const result = transformGrokSessionResponse({
      sessionId: "session-1",
      models: grokModelState,
    });

    expect(result.configOptions).toEqual([
      {
        id: "_paseo.grok.reasoning_effort",
        name: "Reasoning effort",
        category: "thought_level",
        type: "select",
        currentValue: "high",
        options: [
          { value: "xhigh", name: "Extra High Effort", description: undefined },
          { value: "high", name: "High Effort", description: undefined },
          { value: "medium", name: "Medium Effort", description: undefined },
          { value: "low", name: "Low Effort", description: undefined },
        ],
      },
    ]);
  });

  test("does not leak the current model's options onto a model without effort metadata", async () => {
    const models: AgentModelDefinition[] = [
      {
        provider: "acp",
        id: "grok-4.6",
        label: "Grok 4.6",
        thinkingOptions: [{ id: "high", label: "High" }],
        defaultThinkingOptionId: "high",
      },
      {
        provider: "acp",
        id: "custom-model",
        label: "Custom model",
        thinkingOptions: [{ id: "high", label: "High" }],
        defaultThinkingOptionId: "high",
      },
    ];
    const result = applyGrokReasoningOptions(models, {
      ...grokModelState,
      availableModels: [
        grokModelState.availableModels[0],
        { modelId: "custom-model", name: "Custom model" },
      ],
    });

    expect(result[0]?.thinkingOptions?.map((option) => option.id)).toEqual([
      "xhigh",
      "high",
      "medium",
      "low",
    ]);
    expect(result[1]).toEqual({
      provider: "acp",
      id: "custom-model",
      label: "Custom model",
    });
  });

  test("keeps standard ACP thinking options authoritative", async () => {
    const models: AgentModelDefinition[] = [
      {
        provider: "acp",
        id: "grok-4.6",
        label: "Grok 4.6",
        thinkingOptions: [{ id: "medium", label: "Medium", isDefault: true }],
        defaultThinkingOptionId: "medium",
      },
    ];

    const result = await resolveGrokCatalogModels({
      models,
      modelState: grokModelState,
      configOptions: [standardThinkingConfigOption],
    } as ACPCatalogModelResolverContext);

    expect(result).toBe(models);
  });

  test("writes a selected effort through Grok's ACP mode endpoint", async () => {
    const setSessionMode = vi.fn().mockResolvedValue({});

    const result = await writeGrokThinkingOption({
      connection: { setSessionMode } as unknown as ClientSideConnection,
      sessionId: "session-1",
      requestedThinkingOptionId: "low",
      currentThinkingOptionId: "high",
      configOptions: [grokReasoningConfigOption],
    });

    expect(setSessionMode).toHaveBeenCalledOnce();
    expect(setSessionMode).toHaveBeenCalledWith({
      sessionId: "session-1",
      modeId: "low",
    });
    expect(result).toEqual({ handled: true, thinkingOptionId: "low" });
  });

  test("leaves standard ACP thinking writes to the base client", async () => {
    const setSessionMode = vi.fn();

    const result = await writeGrokThinkingOption({
      connection: { setSessionMode } as unknown as ClientSideConnection,
      sessionId: "session-1",
      requestedThinkingOptionId: "medium",
      currentThinkingOptionId: "high",
      configOptions: [standardThinkingConfigOption],
    });

    expect(setSessionMode).not.toHaveBeenCalled();
    expect(result).toEqual({ handled: false });
  });

  test("falls back to the target model's default effort when switching models", async () => {
    const unstableSetSessionModel = vi.fn().mockResolvedValue({});

    const result = await writeGrokModel({
      connection: {
        unstable_setSessionModel: unstableSetSessionModel,
      } as unknown as ClientSideConnection,
      sessionId: "session-1",
      requestedModelId: "grok-4.5",
      currentModelId: "grok-4.6",
      currentThinkingOptionId: "xhigh",
      availableModel: grokModelState.availableModels[1],
      configOptions: [grokReasoningConfigOption],
    });

    expect(unstableSetSessionModel).toHaveBeenCalledWith({
      sessionId: "session-1",
      modelId: "grok-4.5",
      _meta: { reasoningEffort: "high" },
    });
    expect(result).toEqual({
      handled: true,
      currentModelId: "grok-4.5",
      thinkingOptionId: "high",
    });
  });

  test("leaves standard ACP model writes to the base client", async () => {
    const unstableSetSessionModel = vi.fn();

    const result = await writeGrokModel({
      connection: {
        unstable_setSessionModel: unstableSetSessionModel,
      } as unknown as ClientSideConnection,
      sessionId: "session-1",
      requestedModelId: "grok-4.5",
      currentModelId: "grok-4.6",
      currentThinkingOptionId: "medium",
      availableModel: grokModelState.availableModels[1],
      configOptions: [standardThinkingConfigOption],
    });

    expect(unstableSetSessionModel).not.toHaveBeenCalled();
    expect(result).toEqual({ handled: false });
  });
});
