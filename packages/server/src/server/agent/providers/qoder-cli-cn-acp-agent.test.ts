import { SessionConfigOption } from "@agentclientprotocol/sdk";
import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { type SpawnedACPProcess } from "./acp-agent.js";
import { QoderCliCnACPAgentClient } from "./qoder-cli-cn-acp-agent.js";

function modelConfigOption(currentValue: string): SessionConfigOption {
  return {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue,
    options: [
      { value: "auto", name: "Auto" },
      { value: "ultimate", name: "Ultimate" },
      { value: "qwen3.7-max", name: "Qwen3.7-Max" },
    ],
  };
}

function effortThinkingConfigOption(): SessionConfigOption {
  return {
    id: "thinking",
    name: "Thinking",
    category: "thought_level",
    type: "select",
    currentValue: "medium",
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
      { value: "xhigh", name: "XHigh" },
      { value: "max", name: "Max" },
    ],
  };
}

function buildMockProcess(
  newSessionResult: { sessionId: string; configOptions: SessionConfigOption[] },
  setSessionConfigOption: ReturnType<typeof vi.fn>,
): SpawnedACPProcess {
  return {
    child: { kill: vi.fn(), exitCode: 0, signalCode: null, once: vi.fn() },
    connection: {
      newSession: vi.fn().mockResolvedValue(newSessionResult),
      setSessionConfigOption,
    },
    initialize: { agentCapabilities: {} },
  } as unknown as SpawnedACPProcess;
}

function createQoderCliCnClient(
  spawnProcess: () => Promise<SpawnedACPProcess>,
): QoderCliCnACPAgentClient {
  class TestQoderCliCnACPAgentClient extends QoderCliCnACPAgentClient {
    protected override async spawnProcess(): Promise<SpawnedACPProcess> {
      return spawnProcess();
    }

    protected override async closeProbe(): Promise<void> {}
  }

  return new TestQoderCliCnACPAgentClient({
    logger: createTestLogger(),
    command: ["npx", "-y", "@qodercn-ai/qoderclicn@1.1.49", "--acp"],
    providerId: "qoder-cli-cn",
    label: "Qoder CLI CN",
  });
}

function thinkingOptionsEqual() {
  return [
    expect.objectContaining({ id: "low" }),
    expect.objectContaining({ id: "medium", isDefault: true }),
    expect.objectContaining({ id: "high" }),
    expect.objectContaining({ id: "xhigh" }),
    expect.objectContaining({ id: "max" }),
  ];
}

describe("QoderCliCnACPAgentClient per-model thinking options", () => {
  test("each model in the catalog receives its own thinking options", async () => {
    const setSessionConfigOption = vi.fn(async ({ value }: { value: string }) => ({
      configOptions: [modelConfigOption(value), effortThinkingConfigOption()],
    }));

    const client = createQoderCliCnClient(async () =>
      buildMockProcess(
        {
          sessionId: "session-1",
          configOptions: [modelConfigOption("auto"), effortThinkingConfigOption()],
        },
        setSessionConfigOption,
      ),
    );

    const catalog = await client.fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/acp-qoder-cli-cn-thinking",
      force: false,
    });

    for (const model of catalog.models) {
      expect(model.thinkingOptions).toEqual(thinkingOptionsEqual());
    }
  });

  test("skips per-model probing when the provider reports a single model", async () => {
    const setSessionConfigOption = vi.fn();

    const client = createQoderCliCnClient(async () =>
      buildMockProcess(
        {
          sessionId: "session-1",
          configOptions: [
            {
              id: "model",
              name: "Model",
              category: "model",
              type: "select",
              currentValue: "auto",
              options: [{ value: "auto", name: "Auto" }],
            },
            effortThinkingConfigOption(),
          ],
        },
        setSessionConfigOption,
      ),
    );

    const catalog = await client.fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/acp-qoder-cli-cn-single",
      force: false,
    });

    expect(setSessionConfigOption).not.toHaveBeenCalled();
    expect(catalog.models).toHaveLength(1);
    expect(catalog.models[0].thinkingOptions).toBeDefined();
  });

  test("models without thinking support report no thinking options", async () => {
    const setSessionConfigOption = vi.fn(async ({ value }: { value: string }) => ({
      configOptions: [modelConfigOption(value)],
    }));

    const client = createQoderCliCnClient(async () =>
      buildMockProcess(
        { sessionId: "session-1", configOptions: [modelConfigOption("auto")] },
        setSessionConfigOption,
      ),
    );

    const catalog = await client.fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/acp-qoder-cli-cn-no-thinking",
      force: false,
    });

    expect(catalog.models).toHaveLength(3);
    for (const model of catalog.models) {
      expect(model.thinkingOptions).toBeUndefined();
    }
  });

  test("clears thinking options for models whose probe fails", async () => {
    const setSessionConfigOption = vi.fn(async ({ value }: { value: string }) => {
      if (value === "ultimate") {
        throw new Error("probe rejected model switch");
      }
      return { configOptions: [modelConfigOption(value), effortThinkingConfigOption()] };
    });

    const client = createQoderCliCnClient(async () =>
      buildMockProcess(
        {
          sessionId: "session-1",
          configOptions: [modelConfigOption("auto"), effortThinkingConfigOption()],
        },
        setSessionConfigOption,
      ),
    );

    const catalog = await client.fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/acp-qoder-cli-cn-probe-error",
      force: false,
    });

    const autoModel = catalog.models.find((model) => model.id === "auto");
    const ultimateModel = catalog.models.find((model) => model.id === "ultimate");
    const qwenModel = catalog.models.find((model) => model.id === "qwen3.7-max");

    expect(autoModel?.thinkingOptions).toEqual(thinkingOptionsEqual());
    expect(ultimateModel?.thinkingOptions).toBeUndefined();
    expect(qwenModel?.thinkingOptions).toEqual(thinkingOptionsEqual());
  });

  test("probes models even when the initial model lacks thinking options", async () => {
    const noThinkingModelOption: SessionConfigOption = {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "auto",
      options: [
        { value: "auto", name: "Auto" },
        { value: "ultimate", name: "Ultimate" },
      ],
    };

    const setSessionConfigOption = vi.fn(async ({ value }: { value: string }) => {
      if (value === "auto") {
        return { configOptions: [noThinkingModelOption] };
      }
      return { configOptions: [modelConfigOption(value), effortThinkingConfigOption()] };
    });

    const client = createQoderCliCnClient(async () =>
      buildMockProcess(
        { sessionId: "session-1", configOptions: [noThinkingModelOption] },
        setSessionConfigOption,
      ),
    );

    const catalog = await client.fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/acp-qoder-cli-cn-no-initial-thinking",
      force: false,
    });

    const autoModel = catalog.models.find((model) => model.id === "auto");
    const ultimateModel = catalog.models.find((model) => model.id === "ultimate");

    expect(autoModel?.thinkingOptions).toBeUndefined();
    expect(ultimateModel?.thinkingOptions).toEqual(thinkingOptionsEqual());
  });
});
