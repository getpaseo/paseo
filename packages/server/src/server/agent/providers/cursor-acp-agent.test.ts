import { describe, expect, test, vi } from "vitest";

import type { SpawnedACPProcess, SessionStateResponse } from "./acp-agent.js";
import { CURSOR_FAST_FEATURE_OPTION, CursorACPAgentClient } from "./cursor-acp-agent.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";

describe("CursorACPAgentClient model discovery", () => {
  function fastConfigOption(currentValue: "false" | "true") {
    return {
      id: "fast",
      name: "Fast",
      type: "select" as const,
      currentValue,
      options: [
        { value: "false", name: "Off" },
        { value: "true", name: "Fast" },
      ],
    };
  }
  function reasoningConfigOption() {
    return {
      id: "reasoning",
      name: "Reasoning",
      category: "thought_level",
      type: "select" as const,
      currentValue: "max",
      options: [
        { value: "low", name: "Low" },
        { value: "max", name: "Max" },
      ],
    };
  }
  interface CursorCatalogEntry {
    value: string;
    name: string;
    configOptions: unknown[];
  }
  class TestCursorACPAgentClient extends CursorACPAgentClient {
    constructor(response: SessionStateResponse, catalog?: CursorCatalogEntry[]) {
      super({
        logger: createTestLogger(),
        command: ["cursor-agent", "acp"],
      });
      this.response = response;
      this.catalog = catalog;
    }

    private readonly response: SessionStateResponse;
    private readonly catalog?: CursorCatalogEntry[];

    protected override async spawnProcess(): Promise<SpawnedACPProcess> {
      return {
        child: { kill: vi.fn(), exitCode: 0, signalCode: null, once: vi.fn() },
        connection: {
          newSession: vi.fn().mockResolvedValue(this.response),
          extMethod: async () => ({
            models:
              this.catalog ??
              (this.response.models?.availableModels ?? []).map((model) => ({
                value: model.modelId,
                name: model.name,
                configOptions: [],
              })),
          }),
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

  test("hides Cursor fast mode for a drafted model that has no fast variant", async () => {
    const client = new TestCursorACPAgentClient(
      {
        sessionId: "session-1",
        models: null,
        configOptions: [fastConfigOption("true")],
      },
      [
        {
          value: "composer-2.5",
          name: "Composer 2.5",
          configOptions: [fastConfigOption("true")],
        },
        { value: "kimi-k3", name: "Kimi K3", configOptions: [reasoningConfigOption()] },
      ],
    );

    await expect(
      client.listFeatures({
        provider: "acp",
        cwd: "/tmp/cursor",
        model: "kimi-k3",
      }),
    ).resolves.toEqual([expect.objectContaining({ id: "auto_accept" })]);
  });

  test("keeps Cursor fast mode for a drafted model that has a fast variant", async () => {
    const client = new TestCursorACPAgentClient(
      {
        sessionId: "session-1",
        models: null,
        configOptions: [reasoningConfigOption()],
      },
      [
        {
          value: "composer-2.5",
          name: "Composer 2.5",
          configOptions: [fastConfigOption("true")],
        },
        { value: "kimi-k3", name: "Kimi K3", configOptions: [reasoningConfigOption()] },
      ],
    );

    await expect(
      client.listFeatures({
        provider: "acp",
        cwd: "/tmp/cursor",
        model: "composer-2.5",
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: "auto_accept" }),
      expect.objectContaining({ id: CURSOR_FAST_FEATURE_OPTION.id, value: "true" }),
    ]);
  });

  test("falls back to the probe session options when the catalog does not know the model", async () => {
    const client = new TestCursorACPAgentClient(
      {
        sessionId: "session-1",
        models: null,
        configOptions: [fastConfigOption("false")],
      },
      [{ value: "kimi-k3", name: "Kimi K3", configOptions: [reasoningConfigOption()] }],
    );

    await expect(
      client.listFeatures({
        provider: "acp",
        cwd: "/tmp/cursor",
        model: "gpt-5.4[context=272k,reasoning=medium,fast=false]",
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: "auto_accept" }),
      expect.objectContaining({ id: CURSOR_FAST_FEATURE_OPTION.id, value: "false" }),
    ]);
  });
});
