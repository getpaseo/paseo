import { SessionConfigOption } from "@agentclientprotocol/sdk";
import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { type SpawnedACPProcess } from "./acp-agent.js";
import { KimiACPAgentClient } from "./kimi-acp-agent.js";

function modelConfigOption(currentValue: string): SessionConfigOption {
  return {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue,
    options: [
      { value: "kimi-for-coding", name: "K2.7 Coding Fast" },
      { value: "kimi-k3", name: "K3" },
    ],
  };
}

function booleanThinkingConfigOption(): SessionConfigOption {
  return {
    id: "thinking",
    name: "Thinking",
    category: "thought_level",
    type: "select",
    currentValue: "off",
    options: [
      { value: "off", name: "Off" },
      { value: "on", name: "On" },
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
      { value: "off", name: "Off" },
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
    ],
  };
}

function createKimiClient(spawnProcess: () => Promise<SpawnedACPProcess>): KimiACPAgentClient {
  class TestKimiACPAgentClient extends KimiACPAgentClient {
    protected override async spawnProcess(): Promise<SpawnedACPProcess> {
      return spawnProcess();
    }

    protected override async closeProbe(): Promise<void> {}
  }

  return new TestKimiACPAgentClient({
    logger: createTestLogger(),
    command: ["kimi", "acp"],
    providerId: "kimi",
    label: "Kimi Code CLI",
  });
}

describe("KimiACPAgentClient per-model thinking options", () => {
  test("probes each model so a boolean model and an effort-level model keep distinct thinking options", async () => {
    const setSessionConfigOption = vi.fn(async ({ value }: { value: string }) => ({
      configOptions:
        value === "kimi-k3"
          ? [modelConfigOption(value), effortThinkingConfigOption()]
          : [modelConfigOption(value), booleanThinkingConfigOption()],
    }));

    const client = createKimiClient(
      async () =>
        ({
          child: { kill: vi.fn(), exitCode: 0, signalCode: null, once: vi.fn() },
          connection: {
            newSession: vi.fn().mockResolvedValue({
              sessionId: "session-1",
              configOptions: [modelConfigOption("kimi-for-coding"), booleanThinkingConfigOption()],
            }),
            setSessionConfigOption,
          },
          initialize: { agentCapabilities: {} },
        }) as unknown as SpawnedACPProcess,
    );

    const catalog = await client.fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/acp-kimi-thinking",
      force: false,
    });

    expect(setSessionConfigOption).toHaveBeenCalledTimes(2);
    expect(setSessionConfigOption).toHaveBeenNthCalledWith(1, {
      sessionId: "session-1",
      configId: "model",
      value: "kimi-for-coding",
    });
    expect(setSessionConfigOption).toHaveBeenNthCalledWith(2, {
      sessionId: "session-1",
      configId: "model",
      value: "kimi-k3",
    });

    const kimiForCoding = catalog.models.find((model) => model.id === "kimi-for-coding");
    const kimiK3 = catalog.models.find((model) => model.id === "kimi-k3");

    expect(kimiForCoding?.thinkingOptions).toEqual([
      expect.objectContaining({ id: "off", isDefault: true }),
      expect.objectContaining({ id: "on", isDefault: false }),
    ]);
    expect(kimiK3?.thinkingOptions).toEqual([
      expect.objectContaining({ id: "off", isDefault: false }),
      expect.objectContaining({ id: "low", isDefault: false }),
      expect.objectContaining({ id: "medium", isDefault: true }),
      expect.objectContaining({ id: "high", isDefault: false }),
    ]);
  });

  test("skips per-model probing when the provider reports a single model", async () => {
    const setSessionConfigOption = vi.fn();

    const client = createKimiClient(
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
                  currentValue: "kimi-for-coding",
                  options: [{ value: "kimi-for-coding", name: "K2.7 Coding Fast" }],
                },
                booleanThinkingConfigOption(),
              ],
            }),
            setSessionConfigOption,
          },
          initialize: { agentCapabilities: {} },
        }) as unknown as SpawnedACPProcess,
    );

    await client.fetchCatalog({ scope: "workspace", cwd: "/tmp/acp-kimi-single", force: false });

    expect(setSessionConfigOption).not.toHaveBeenCalled();
  });

  test("skips per-model probing when the provider has no thinking picker", async () => {
    const setSessionConfigOption = vi.fn();

    const client = createKimiClient(
      async () =>
        ({
          child: { kill: vi.fn(), exitCode: 0, signalCode: null, once: vi.fn() },
          connection: {
            newSession: vi.fn().mockResolvedValue({
              sessionId: "session-1",
              configOptions: [modelConfigOption("kimi-for-coding")],
            }),
            setSessionConfigOption,
          },
          initialize: { agentCapabilities: {} },
        }) as unknown as SpawnedACPProcess,
    );

    await client.fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/acp-kimi-no-thinking",
      force: false,
    });

    expect(setSessionConfigOption).not.toHaveBeenCalled();
  });

  test("keeps a model's default thinking options when its probe fails", async () => {
    const setSessionConfigOption = vi.fn(async ({ value }: { value: string }) => {
      if (value === "kimi-k3") {
        throw new Error("probe rejected model switch");
      }
      return { configOptions: [modelConfigOption(value), booleanThinkingConfigOption()] };
    });

    const client = createKimiClient(
      async () =>
        ({
          child: { kill: vi.fn(), exitCode: 0, signalCode: null, once: vi.fn() },
          connection: {
            newSession: vi.fn().mockResolvedValue({
              sessionId: "session-1",
              configOptions: [modelConfigOption("kimi-for-coding"), booleanThinkingConfigOption()],
            }),
            setSessionConfigOption,
          },
          initialize: { agentCapabilities: {} },
        }) as unknown as SpawnedACPProcess,
    );

    const catalog = await client.fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/acp-kimi-probe-error",
      force: false,
    });

    const kimiK3 = catalog.models.find((model) => model.id === "kimi-k3");
    expect(kimiK3?.thinkingOptions).toEqual([
      expect.objectContaining({ id: "off", isDefault: true }),
      expect.objectContaining({ id: "on", isDefault: false }),
    ]);
  });
});
