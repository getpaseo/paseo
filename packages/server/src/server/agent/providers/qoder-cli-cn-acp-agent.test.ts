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

describe("QoderCliCnACPAgentClient per-model thinking options", () => {
  test("probes each model so models with different thinking support keep distinct options", async () => {
    const setSessionConfigOption = vi.fn(async ({ value }: { value: string }) => ({
      configOptions: [modelConfigOption(value), effortThinkingConfigOption()],
    }));

    const client = createQoderCliCnClient(
      async () =>
        ({
          child: { kill: vi.fn(), exitCode: 0, signalCode: null, once: vi.fn() },
          connection: {
            newSession: vi.fn().mockResolvedValue({
              sessionId: "session-1",
              configOptions: [modelConfigOption("auto"), effortThinkingConfigOption()],
            }),
            setSessionConfigOption,
          },
          initialize: { agentCapabilities: {} },
        }) as unknown as SpawnedACPProcess,
    );

    const catalog = await client.fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/acp-qoder-cli-cn-thinking",
      force: false,
    });

    expect(setSessionConfigOption).toHaveBeenCalledTimes(3);
    expect(setSessionConfigOption).toHaveBeenNthCalledWith(1, {
      sessionId: "session-1",
      configId: "model",
      value: "auto",
    });
    expect(setSessionConfigOption).toHaveBeenNthCalledWith(2, {
      sessionId: "session-1",
      configId: "model",
      value: "ultimate",
    });
    expect(setSessionConfigOption).toHaveBeenNthCalledWith(3, {
      sessionId: "session-1",
      configId: "model",
      value: "qwen3.7-max",
    });

    const autoModel = catalog.models.find((model) => model.id === "auto");
    const qwenModel = catalog.models.find((model) => model.id === "qwen3.7-max");

    expect(autoModel?.thinkingOptions).toEqual([
      expect.objectContaining({ id: "low" }),
      expect.objectContaining({ id: "medium", isDefault: true }),
      expect.objectContaining({ id: "high" }),
      expect.objectContaining({ id: "xhigh" }),
      expect.objectContaining({ id: "max" }),
    ]);
    expect(qwenModel?.thinkingOptions).toEqual([
      expect.objectContaining({ id: "low" }),
      expect.objectContaining({ id: "medium", isDefault: true }),
      expect.objectContaining({ id: "high" }),
      expect.objectContaining({ id: "xhigh" }),
      expect.objectContaining({ id: "max" }),
    ]);
  });

  test("skips per-model probing when the provider reports a single model", async () => {
    const setSessionConfigOption = vi.fn();

    const client = createQoderCliCnClient(
      async () =>
        ({
          child: { kill: vi.fn(), exitCode: 0, signalCode: null, once: vi.fn() },
          connection: {
            newSession: vi.fn().mockResolvedValue({
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
            }),
            setSessionConfigOption,
          },
          initialize: { agentCapabilities: {} },
        }) as unknown as SpawnedACPProcess,
    );

    await client.fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/acp-qoder-cli-cn-single",
      force: false,
    });

    expect(setSessionConfigOption).not.toHaveBeenCalled();
  });

  test("skips per-model probing when the provider has no thinking picker", async () => {
    const setSessionConfigOption = vi.fn();

    const client = createQoderCliCnClient(
      async () =>
        ({
          child: { kill: vi.fn(), exitCode: 0, signalCode: null, once: vi.fn() },
          connection: {
            newSession: vi.fn().mockResolvedValue({
              sessionId: "session-1",
              configOptions: [modelConfigOption("auto")],
            }),
            setSessionConfigOption,
          },
          initialize: { agentCapabilities: {} },
        }) as unknown as SpawnedACPProcess,
    );

    await client.fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/acp-qoder-cli-cn-no-thinking",
      force: false,
    });

    expect(setSessionConfigOption).not.toHaveBeenCalled();
  });

  test("keeps a model's default thinking options when its probe fails", async () => {
    const setSessionConfigOption = vi.fn(async ({ value }: { value: string }) => {
      if (value === "ultimate") {
        throw new Error("probe rejected model switch");
      }
      return { configOptions: [modelConfigOption(value), effortThinkingConfigOption()] };
    });

    const client = createQoderCliCnClient(
      async () =>
        ({
          child: { kill: vi.fn(), exitCode: 0, signalCode: null, once: vi.fn() },
          connection: {
            newSession: vi.fn().mockResolvedValue({
              sessionId: "session-1",
              configOptions: [modelConfigOption("auto"), effortThinkingConfigOption()],
            }),
            setSessionConfigOption,
          },
          initialize: { agentCapabilities: {} },
        }) as unknown as SpawnedACPProcess,
    );

    const catalog = await client.fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/acp-qoder-cli-cn-probe-error",
      force: false,
    });

    const ultimateModel = catalog.models.find((model) => model.id === "ultimate");
    expect(ultimateModel?.thinkingOptions).toEqual([
      expect.objectContaining({ id: "low" }),
      expect.objectContaining({ id: "medium", isDefault: true }),
      expect.objectContaining({ id: "high" }),
      expect.objectContaining({ id: "xhigh" }),
      expect.objectContaining({ id: "max" }),
    ]);
  });
});
