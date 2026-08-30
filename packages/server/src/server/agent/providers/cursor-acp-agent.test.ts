import { SessionConfigOption } from "@agentclientprotocol/sdk";
import { describe, expect, test, vi } from "vitest";

import type { SpawnedACPProcess, SessionStateResponse } from "./acp-agent.js";
import {
  CURSOR_CONTEXT_FEATURE_OPTION,
  CURSOR_FAST_FEATURE_OPTION,
  CursorACPAgentClient,
  normalizeCursorSessionConfig,
  parseCursorModelId,
} from "./cursor-acp-agent.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";

describe("CursorACPAgentClient model discovery", () => {
  function fastConfigOption(currentValue: "false" | "true"): SessionConfigOption {
    return {
      id: "fast",
      name: "Fast",
      category: "model_config",
      type: "select",
      currentValue,
      options: [
        { value: "false", name: "Off" },
        { value: "true", name: "Fast" },
      ],
    };
  }

  function contextConfigOption(currentValue: "300k" | "1m"): SessionConfigOption {
    return {
      id: "context",
      name: "Context",
      category: "model_config",
      type: "select",
      currentValue,
      options: [
        { value: "300k", name: "300K" },
        { value: "1m", name: "1M" },
      ],
    };
  }

  function effortConfigOption(
    currentValue: string,
    values: string[] = ["low", "medium", "high", "xhigh"],
  ): SessionConfigOption {
    return {
      id: "effort",
      name: "Effort",
      category: "thought_level",
      type: "select",
      currentValue,
      options: values.map((value) => ({ value, name: value })),
    };
  }

  function reasoningConfigOption(currentValue: string): SessionConfigOption {
    return {
      id: "reasoning",
      name: "Reasoning",
      category: "thought_level",
      type: "select",
      currentValue,
      options: [
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
        { value: "max", name: "Max" },
      ],
    };
  }

  function thinkingToggleConfigOption(currentValue: "false" | "true"): SessionConfigOption {
    return {
      id: "thinking",
      name: "Thinking",
      category: "thought_level",
      type: "select",
      currentValue,
      options: [
        { value: "false", name: "Off" },
        { value: "true", name: "On" },
      ],
    };
  }

  function modelConfigOption(currentValue: string): SessionConfigOption {
    return {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue,
      options: [
        { value: "kimi-k3", name: "Kimi K3" },
        { value: "grok-4.6", name: "Cursor Grok 4.6" },
        { value: "claude-fable-5", name: "Claude Fable 5" },
        { value: "composer-2.5", name: "Composer 2.5" },
      ],
    };
  }

  function parameterizedModels(
    currentModelId: string,
  ): NonNullable<SessionStateResponse["models"]> {
    return {
      currentModelId,
      availableModels: [
        { modelId: "kimi-k3", name: "Kimi K3", description: null },
        { modelId: "grok-4.6", name: "Cursor Grok 4.6", description: null },
        { modelId: "claude-fable-5", name: "Claude Fable 5", description: null },
        { modelId: "composer-2.5", name: "Composer 2.5", description: null },
      ],
    };
  }

  class TestCursorACPAgentClient extends CursorACPAgentClient {
    constructor(
      response: SessionStateResponse,
      setSessionConfigOption?: SpawnedACPProcess["connection"]["setSessionConfigOption"],
    ) {
      super({
        logger: createTestLogger(),
        command: ["cursor-agent", "acp"],
      });
      this.response = response;
      this.setSessionConfigOption = setSessionConfigOption;
    }

    private readonly response: SessionStateResponse;
    private readonly setSessionConfigOption?: SpawnedACPProcess["connection"]["setSessionConfigOption"];

    protected override async spawnProcess(): Promise<SpawnedACPProcess> {
      return {
        child: { kill: vi.fn(), exitCode: 0, signalCode: null, once: vi.fn() },
        connection: {
          newSession: vi.fn().mockResolvedValue(this.response),
          setSessionConfigOption: this.setSessionConfigOption,
        },
        initialize: { agentCapabilities: {} },
      } as SpawnedACPProcess;
    }

    protected override async closeProbe(): Promise<void> {}
  }

  test("returns only ACP model ids because Cursor CLI ids cannot select ACP models", async () => {
    const client = new TestCursorACPAgentClient({
      sessionId: "session-1",
      models: {
        currentModelId: "gpt-5.4[context=272k,reasoning=medium,fast=false]",
        availableModels: [
          {
            modelId: "gpt-5.4[context=272k,reasoning=medium,fast=false]",
            name: "gpt-5.4",
            description: null,
          },
        ],
      },
      configOptions: [],
    });

    await expect(
      client.fetchCatalog({ scope: "workspace", cwd: "/tmp/cursor", force: false }),
    ).resolves.toEqual({
      models: [
        {
          provider: "acp",
          id: "gpt-5.4[context=272k,reasoning=medium,fast=false]",
          label: "gpt-5.4",
          description: undefined,
          isDefault: true,
          thinkingOptions: undefined,
          defaultThinkingOptionId: undefined,
        },
      ],
      modes: [],
    });
  });

  test("does not fall back to cursor-agent models when ACP reports zero models", async () => {
    const client = new TestCursorACPAgentClient({
      sessionId: "session-1",
      models: null,
      configOptions: [],
    });

    await expect(
      client.fetchCatalog({ scope: "workspace", cwd: "/tmp/cursor", force: false }),
    ).resolves.toEqual({
      models: [],
      modes: [],
    });
  });

  test("keeps modern Cursor models as plain ACP ids", async () => {
    const client = new TestCursorACPAgentClient({
      sessionId: "session-1",
      models: {
        currentModelId: "composer-2.5",
        availableModels: [
          {
            modelId: "composer-2.5",
            name: "Composer 2.5",
            description: null,
          },
        ],
      },
      configOptions: [fastConfigOption("false")],
    });

    await expect(
      client.fetchCatalog({ scope: "workspace", cwd: "/tmp/cursor", force: false }),
    ).resolves.toEqual({
      models: [
        {
          provider: "acp",
          id: "composer-2.5",
          label: "Composer 2.5",
          description: undefined,
          isDefault: true,
          thinkingOptions: undefined,
          defaultThinkingOptionId: undefined,
        },
      ],
      modes: [],
    });
  });

  test("exposes Cursor fast mode through provider features", async () => {
    const client = new TestCursorACPAgentClient({
      sessionId: "session-1",
      models: null,
      configOptions: [fastConfigOption("false")],
    });

    await expect(
      client.listFeatures({
        provider: "acp",
        cwd: "/tmp/cursor",
      }),
    ).resolves.toEqual([
      {
        type: "toggle",
        id: "auto_accept",
        label: "Auto Accept",
        description: "Automatically approves ACP permission prompts.",
        tooltip: "Auto accept permission prompts",
        icon: "shield-check",
        value: false,
      },
      {
        type: "select",
        id: CURSOR_FAST_FEATURE_OPTION.id,
        label: "Fast",
        description: "Cursor fast mode",
        tooltip: "Select Cursor fast mode",
        icon: "zap",
        value: "false",
        options: [
          {
            id: "false",
            label: "Off",
            isDefault: true,
            description: undefined,
            metadata: undefined,
          },
          {
            id: "true",
            label: "Fast",
            isDefault: false,
            description: undefined,
            metadata: undefined,
          },
        ],
      },
    ]);
  });

  test("probes each model so effort, reasoning, and Fast stay per-model", async () => {
    const setSessionConfigOption = vi.fn(async ({ value }: { value: string }) => {
      if (value === "grok-4.6") {
        return {
          configOptions: [
            modelConfigOption(value),
            effortConfigOption("high"),
            fastConfigOption("true"),
          ],
        };
      }
      if (value === "claude-fable-5") {
        return {
          configOptions: [
            modelConfigOption(value),
            thinkingToggleConfigOption("true"),
            contextConfigOption("300k"),
            effortConfigOption("high", ["low", "medium", "high", "xhigh", "max"]),
          ],
        };
      }
      return { configOptions: [modelConfigOption(value), fastConfigOption("true")] };
    });

    const client = new TestCursorACPAgentClient(
      {
        sessionId: "session-1",
        models: parameterizedModels("kimi-k3"),
        configOptions: [modelConfigOption("kimi-k3"), reasoningConfigOption("max")],
      },
      setSessionConfigOption,
    );

    const catalog = await client.fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/cursor-thinking",
      force: false,
    });

    expect(setSessionConfigOption).toHaveBeenCalledTimes(3);
    expect(setSessionConfigOption.mock.calls.map((call) => call[0].value)).toEqual([
      "grok-4.6",
      "claude-fable-5",
      "composer-2.5",
    ]);

    const k3 = catalog.models.find((model) => model.id === "kimi-k3");
    const grok = catalog.models.find((model) => model.id === "grok-4.6");
    const fable = catalog.models.find((model) => model.id === "claude-fable-5");
    const composer = catalog.models.find((model) => model.id === "composer-2.5");

    expect(k3?.thinkingOptions?.map((option) => option.id)).toEqual(["low", "high", "max"]);
    expect(k3?.defaultThinkingOptionId).toBe("max");
    expect(grok?.thinkingOptions?.map((option) => option.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(grok?.defaultThinkingOptionId).toBe("high");
    expect(fable?.thinkingOptions?.map((option) => option.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(fable?.defaultThinkingOptionId).toBe("high");
    expect(composer?.thinkingOptions).toBeUndefined();
    expect(composer?.defaultThinkingOptionId).toBeUndefined();
  });

  test("lists Fast and Context for the drafted Cursor model, not the default session model", async () => {
    const setSessionConfigOption = vi.fn(async ({ value }: { value: string }) => {
      if (value === "grok-4.6") {
        return {
          configOptions: [
            modelConfigOption(value),
            effortConfigOption("high"),
            fastConfigOption("true"),
          ],
        };
      }
      return {
        configOptions: [
          modelConfigOption(value),
          thinkingToggleConfigOption("true"),
          contextConfigOption("300k"),
          effortConfigOption("high", ["low", "medium", "high", "xhigh", "max"]),
        ],
      };
    });

    const client = new TestCursorACPAgentClient(
      {
        sessionId: "session-1",
        models: parameterizedModels("kimi-k3"),
        configOptions: [modelConfigOption("kimi-k3"), reasoningConfigOption("max")],
      },
      setSessionConfigOption,
    );

    const grokFeatures = await client.listFeatures({
      provider: "acp",
      cwd: "/tmp/cursor-features",
      model: "grok-4.6",
    });
    const fableFeatures = await client.listFeatures({
      provider: "acp",
      cwd: "/tmp/cursor-features",
      model: "claude-fable-5",
    });

    expect(grokFeatures.map((feature) => feature.id)).toEqual(["auto_accept", "fast"]);
    expect(fableFeatures.map((feature) => feature.id)).toEqual([
      "auto_accept",
      CURSOR_CONTEXT_FEATURE_OPTION.id,
    ]);
    expect(setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "session-1",
      configId: "model",
      value: "grok-4.6",
    });
    expect(setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "session-1",
      configId: "model",
      value: "claude-fable-5",
    });
  });
});

describe("Cursor parameterized model IDs", () => {
  test("parses base IDs, empty brackets, and effort/fast params", () => {
    expect(parseCursorModelId("grok-4.6")).toEqual({ modelId: "grok-4.6", params: {} });
    expect(parseCursorModelId("default[]")).toEqual({ modelId: "default", params: {} });
    expect(parseCursorModelId("grok-4.6[effort=xhigh,fast=false]")).toEqual({
      modelId: "grok-4.6",
      params: { effort: "xhigh", fast: "false" },
    });
    expect(parseCursorModelId("kimi-k3[reasoning=low]")).toEqual({
      modelId: "kimi-k3",
      params: { reasoning: "low" },
    });
  });

  test("turns persisted Cursor variant IDs into base model plus thinking and features", () => {
    expect(
      normalizeCursorSessionConfig({
        provider: "acp",
        cwd: "/tmp/cursor",
        model: "grok-4.6[effort=xhigh,fast=false]",
      }),
    ).toEqual({
      provider: "acp",
      cwd: "/tmp/cursor",
      model: "grok-4.6",
      thinkingOptionId: "xhigh",
      featureValues: { fast: "false" },
    });
    expect(
      normalizeCursorSessionConfig({
        provider: "acp",
        cwd: "/tmp/cursor",
        model: "claude-fable-5[thinking=true,context=1m,effort=max]",
        thinkingOptionId: "high",
        featureValues: { context: "300k" },
      }),
    ).toEqual({
      provider: "acp",
      cwd: "/tmp/cursor",
      model: "claude-fable-5",
      thinkingOptionId: "high",
      featureValues: { context: "300k" },
    });
  });
});
