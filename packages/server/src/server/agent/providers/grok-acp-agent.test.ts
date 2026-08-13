import { describe, expect, test, vi } from "vitest";

import type { AgentModelDefinition } from "../agent-sdk-types.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { SessionStateResponse, SpawnedACPProcess } from "./acp-agent.js";
import {
  applyGrokThinkingToModels,
  extractGrokThinkingByModel,
  GrokACPAgentClient,
  transformGrokSessionResponse,
  writeGrokThinkingOption,
} from "./grok-acp-agent.js";

function grok46Meta(currentEffort = "high") {
  return {
    totalContextTokens: 500000,
    agentType: "grok-build-plan",
    supportsReasoningEffort: true,
    reasoningEffort: currentEffort,
    reasoningEfforts: [
      {
        id: "xhigh",
        value: "xhigh",
        label: "Extra High Effort",
        description: "Highest effort and reasoning level",
        default: true,
      },
      {
        id: "high",
        value: "high",
        label: "High Effort",
        description: "Higher implementation quality with extensive reasoning",
        default: true,
      },
      {
        id: "medium",
        value: "medium",
        label: "Medium Effort",
        description: "Balanced effort with standard implementation and testing",
        default: false,
      },
      {
        id: "low",
        value: "low",
        label: "Low Effort",
        description: "Quick, fast implementations",
        default: false,
      },
    ],
  };
}

function grok45Meta() {
  return {
    totalContextTokens: 500000,
    agentType: "grok-build-plan",
    supportsReasoningEffort: true,
    reasoningEffort: "high",
    reasoningEfforts: [
      {
        id: "high",
        value: "high",
        label: "High Effort",
        description: "Highest implementation quality with extensive reasoning",
        default: true,
      },
      {
        id: "medium",
        value: "medium",
        label: "Medium Effort",
        description: "Balanced effort with standard implementation and testing",
        default: false,
      },
      {
        id: "low",
        value: "low",
        label: "Low Effort",
        description: "Quick, fast implementations",
        default: false,
      },
    ],
  };
}

function grokSessionResponse(): SessionStateResponse {
  return {
    sessionId: "session-1",
    models: {
      currentModelId: "grok-4.6",
      availableModels: [
        {
          modelId: "grok-4.6",
          name: "Grok 4.6",
          description: "SpaceXAI's latest frontier model",
          _meta: grok46Meta(),
        },
        {
          modelId: "grok-4.5",
          name: "Grok 4.5",
          _meta: grok45Meta(),
        },
      ],
    },
    _meta: {
      "x.ai/sessionConfig": {
        options: [
          { id: "grok-4.6", category: "model", label: "Grok 4.6", selected: true },
          { id: "xhigh", category: "mode", label: "Extra High Effort", selected: false },
          { id: "high", category: "mode", label: "High Effort", selected: true },
          { id: "medium", category: "mode", label: "Medium Effort", selected: false },
          { id: "low", category: "mode", label: "Low Effort", selected: false },
        ],
      },
    },
  };
}

function createGrokClient(spawnProcess: () => Promise<SpawnedACPProcess>): GrokACPAgentClient {
  class TestGrokACPAgentClient extends GrokACPAgentClient {
    protected override async spawnProcess(): Promise<SpawnedACPProcess> {
      return spawnProcess();
    }

    protected override async closeProbe(): Promise<void> {}
  }

  return new TestGrokACPAgentClient({
    logger: createTestLogger(),
    command: ["grok", "agent", "stdio"],
    providerId: "grok",
    label: "Grok",
  });
}

describe("GrokACPAgentClient thinking options", () => {
  test("maps per-model reasoning efforts from ACP model _meta", () => {
    const thinkingByModel = extractGrokThinkingByModel(grokSessionResponse());

    expect(thinkingByModel.get("grok-4.6")).toEqual({
      currentId: "high",
      options: [
        expect.objectContaining({ id: "xhigh", label: "Extra High Effort", isDefault: false }),
        expect.objectContaining({ id: "high", label: "High Effort", isDefault: true }),
        expect.objectContaining({ id: "medium", label: "Medium Effort", isDefault: false }),
        expect.objectContaining({ id: "low", label: "Low Effort", isDefault: false }),
      ],
    });
    expect(thinkingByModel.get("grok-4.5")?.options.map((option) => option.id)).toEqual([
      "high",
      "medium",
      "low",
    ]);
  });

  test("synthesizes a thought_level config option from the current model's efforts", () => {
    const transformed = transformGrokSessionResponse(grokSessionResponse());

    expect(transformed.configOptions).toEqual([
      {
        id: "thought_level",
        name: "Effort",
        category: "thought_level",
        type: "select",
        currentValue: "high",
        options: [
          {
            value: "xhigh",
            name: "Extra High Effort",
            description: "Highest effort and reasoning level",
          },
          {
            value: "high",
            name: "High Effort",
            description: "Higher implementation quality with extensive reasoning",
          },
          {
            value: "medium",
            name: "Medium Effort",
            description: "Balanced effort with standard implementation and testing",
          },
          {
            value: "low",
            name: "Low Effort",
            description: "Quick, fast implementations",
          },
        ],
      },
    ]);
    expect(transformed.modes).toBeUndefined();
  });

  test("falls back to x.ai/sessionConfig effort rows when model _meta has no efforts", () => {
    const thinkingByModel = extractGrokThinkingByModel({
      sessionId: "session-1",
      models: {
        currentModelId: "grok-4.6",
        availableModels: [{ modelId: "grok-4.6", name: "Grok 4.6" }],
      },
      _meta: {
        "x.ai/sessionConfig": {
          options: [
            { id: "grok-4.6", category: "model", label: "Grok 4.6", selected: true },
            { id: "high", category: "mode", label: "High Effort", selected: true },
            { id: "low", category: "mode", label: "Low Effort", selected: false },
          ],
        },
      },
    });

    expect(thinkingByModel.get("grok-4.6")).toEqual({
      currentId: "high",
      options: [
        expect.objectContaining({ id: "high", isDefault: true }),
        expect.objectContaining({ id: "low", isDefault: false }),
      ],
    });
  });

  test("catalog probe attaches distinct thinking options per model", async () => {
    const client = createGrokClient(async () => {
      return {
        child: { kill: vi.fn(), exitCode: 0, signalCode: null, once: vi.fn() },
        connection: {
          newSession: vi.fn().mockResolvedValue(grokSessionResponse()),
        },
        initialize: { agentCapabilities: {} },
      } as unknown as SpawnedACPProcess;
    });

    const catalog = await client.fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/acp-grok-thinking",
      force: false,
    });

    const grok46 = catalog.models.find((model) => model.id === "grok-4.6");
    const grok45 = catalog.models.find((model) => model.id === "grok-4.5");

    expect(grok46?.thinkingOptions?.map((option) => option.id)).toEqual([
      "xhigh",
      "high",
      "medium",
      "low",
    ]);
    expect(grok46?.defaultThinkingOptionId).toBe("high");
    expect(grok45?.thinkingOptions?.map((option) => option.id)).toEqual(["high", "medium", "low"]);
    expect(grok45?.defaultThinkingOptionId).toBe("high");
  });

  test("writes thinking changes through session/set_mode", async () => {
    const setSessionMode = vi.fn().mockResolvedValue({});

    await writeGrokThinkingOption({ setSessionMode } as never, "session-1", "low");

    expect(setSessionMode).toHaveBeenCalledWith({
      sessionId: "session-1",
      modeId: "low",
    });
  });

  test("model transformer overlays extracted thinking onto catalog models", () => {
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
      },
    ];
    const thinkingByModelId = extractGrokThinkingByModel(grokSessionResponse());

    expect(applyGrokThinkingToModels(models, thinkingByModelId)).toEqual([
      {
        provider: "acp",
        id: "grok-4.6",
        label: "Grok 4.6",
        isDefault: true,
        thinkingOptions: thinkingByModelId.get("grok-4.6")?.options,
        defaultThinkingOptionId: "high",
      },
      {
        provider: "acp",
        id: "grok-4.5",
        label: "Grok 4.5",
        thinkingOptions: thinkingByModelId.get("grok-4.5")?.options,
        defaultThinkingOptionId: "high",
      },
    ]);
  });
});
