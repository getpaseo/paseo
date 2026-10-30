import { SessionConfigOption } from "@agentclientprotocol/sdk";
import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentModelDefinition } from "../agent-sdk-types.js";
import { type SpawnedACPProcess } from "./acp-agent.js";
import { CopilotACPAgentClient } from "./copilot-acp-agent.js";

// Shapes and effort lists as reported by Copilot CLI 1.0.88 over `copilot --acp`.
const COPILOT_MODELS = [
  { modelId: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
  { modelId: "kimi-k3", name: "Kimi K3" },
  { modelId: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
];

const REASONING_EFFORTS_BY_MODEL: Record<string, { values: string[]; currentValue: string }> = {
  "gpt-5.6-terra": {
    values: ["none", "low", "medium", "high", "xhigh", "max"],
    currentValue: "medium",
  },
  "kimi-k3": { values: ["low", "high", "max"], currentValue: "high" },
};

function copilotConfigOptions(modelId: string): SessionConfigOption[] {
  const configOptions: SessionConfigOption[] = [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: modelId,
      options: COPILOT_MODELS.map((model) => ({ value: model.modelId, name: model.name })),
    },
  ];
  const efforts = REASONING_EFFORTS_BY_MODEL[modelId];
  if (efforts) {
    configOptions.push({
      id: "reasoning_effort",
      name: "Reasoning Effort",
      category: "thought_level",
      type: "select",
      currentValue: efforts.currentValue,
      options: efforts.values.map((value) => ({ value, name: value })),
    });
  }
  return configOptions;
}

interface ThinkingSummary {
  optionIds: string[] | undefined;
  defaultOptionId: string | undefined;
}

function summarizeThinking(model: AgentModelDefinition): [string, ThinkingSummary] {
  return [
    model.id,
    {
      optionIds: model.thinkingOptions?.map((option) => option.id),
      defaultOptionId: model.defaultThinkingOptionId,
    },
  ];
}

function createCopilotClient(spawnProcess: () => Promise<SpawnedACPProcess>) {
  class TestCopilotACPAgentClient extends CopilotACPAgentClient {
    protected override async spawnProcess(): Promise<SpawnedACPProcess> {
      return spawnProcess();
    }

    protected override async closeProbe(): Promise<void> {}
  }

  return new TestCopilotACPAgentClient({ logger: createTestLogger() });
}

describe("CopilotACPAgentClient per-model thinking options", () => {
  test("lists each model's own reasoning efforts instead of the default model's", async () => {
    const setSessionConfigOption = vi.fn(async ({ value }: { value: string }) => ({
      configOptions: copilotConfigOptions(value),
    }));
    const client = createCopilotClient(
      async () =>
        ({
          child: { kill: vi.fn(), exitCode: 0, signalCode: null, once: vi.fn() },
          connection: {
            newSession: vi.fn().mockResolvedValue({
              sessionId: "session-1",
              models: { availableModels: COPILOT_MODELS, currentModelId: "gpt-5.6-terra" },
              configOptions: copilotConfigOptions("gpt-5.6-terra"),
            }),
            setSessionConfigOption,
          },
          initialize: { agentCapabilities: {} },
        }) as unknown as SpawnedACPProcess,
    );

    const catalog = await client.fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/acp-copilot-thinking",
      force: false,
    });

    const thinkingByModel = Object.fromEntries(catalog.models.map(summarizeThinking));
    expect(thinkingByModel).toEqual({
      "gpt-5.6-terra": {
        optionIds: ["none", "low", "medium", "high", "xhigh", "max"],
        defaultOptionId: "medium",
      },
      "kimi-k3": { optionIds: ["low", "high", "max"], defaultOptionId: "high" },
      "claude-haiku-4.5": { optionIds: undefined, defaultOptionId: undefined },
    });
  });
});
