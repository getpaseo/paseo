import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { type SpawnedACPProcess } from "./acp-agent.js";
import { GooseACPAgentClient, writeGooseModel } from "./goose-acp-agent.js";

// goose's provider select carries no category, unlike its model and thinking selects.
function providerConfigOption(currentValue: string): SessionConfigOption {
  return {
    id: "provider",
    name: "Provider",
    type: "select",
    currentValue,
    options: [
      { value: "ollama", name: "Ollama" },
      { value: "openai", name: "OpenAI" },
      { value: "unconfigured", name: "Unconfigured" },
      { value: "groq", name: "Groq" },
    ],
  };
}

function modelConfigOption(
  currentValue: string,
  options: { value: string; name: string }[],
): SessionConfigOption {
  return { id: "model", name: "Model", category: "model", type: "select", currentValue, options };
}

function thinkingConfigOption(): SessionConfigOption {
  return {
    id: "thinking",
    name: "Thinking",
    category: "thought_level",
    type: "select",
    currentValue: "high",
    options: [
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
    ],
  };
}

const OLLAMA_MODELS = [
  { value: "qwen3", name: "Qwen3" },
  { value: "llama3", name: "Llama3" },
];
const OPENAI_MODELS = [{ value: "gpt-4o", name: "GPT-4o" }];

function providerResponse(value: string): { configOptions: SessionConfigOption[] } {
  if (value === "groq") {
    throw new Error("Internal error");
  }
  if (value === "openai") {
    return {
      configOptions: [
        providerConfigOption(value),
        modelConfigOption("gpt-4o", OPENAI_MODELS),
        thinkingConfigOption(),
      ],
    };
  }
  if (value === "unconfigured") {
    return {
      configOptions: [
        providerConfigOption(value),
        modelConfigOption("", [{ value: "", name: "" }]),
      ],
    };
  }
  return {
    configOptions: [providerConfigOption(value), modelConfigOption("qwen3", OLLAMA_MODELS)],
  };
}

function createGooseClient(spawnProcess: () => Promise<SpawnedACPProcess>): GooseACPAgentClient {
  class TestGooseACPAgentClient extends GooseACPAgentClient {
    protected override async spawnProcess(): Promise<SpawnedACPProcess> {
      return spawnProcess();
    }

    protected override async closeProbe(): Promise<void> {}
  }

  return new TestGooseACPAgentClient({
    logger: createTestLogger(),
    command: ["goose", "acp"],
    providerId: "goose",
    label: "Goose",
  });
}

function spawnWith(
  configOptions: SessionConfigOption[],
  setSessionConfigOption: ReturnType<typeof vi.fn>,
): () => Promise<SpawnedACPProcess> {
  return async () =>
    ({
      child: { kill: vi.fn(), exitCode: 0, signalCode: null, once: vi.fn() },
      connection: {
        newSession: vi.fn().mockResolvedValue({ sessionId: "session-1", configOptions }),
        setSessionConfigOption,
      },
      initialize: { agentCapabilities: {} },
    }) as unknown as SpawnedACPProcess;
}

describe("GooseACPAgentClient catalog", () => {
  test("namespaces models from every provider and keeps thinking options per provider", async () => {
    const setSessionConfigOption = vi.fn(async ({ value }: { value: string }) =>
      providerResponse(value),
    );
    const client = createGooseClient(
      spawnWith(
        [providerConfigOption("ollama"), modelConfigOption("qwen3", OLLAMA_MODELS)],
        setSessionConfigOption,
      ),
    );

    const catalog = await client.fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/acp-goose-sweep",
      force: false,
    });

    expect(catalog.models.map((model) => model.id)).toEqual([
      "ollama/qwen3",
      "ollama/llama3",
      "openai/gpt-4o",
    ]);
    expect(catalog.models.map((model) => model.description)).toEqual([
      "Ollama",
      "Ollama",
      "OpenAI",
    ]);
    expect(catalog.models.map((model) => model.isDefault)).toEqual([true, false, false]);

    const ollama = catalog.models.find((model) => model.id === "ollama/qwen3");
    const openai = catalog.models.find((model) => model.id === "openai/gpt-4o");
    expect(ollama?.thinkingOptions).toBeUndefined();
    expect(openai?.thinkingOptions).toEqual([
      expect.objectContaining({ id: "low", isDefault: false }),
      expect.objectContaining({ id: "high", isDefault: true }),
    ]);
    expect(openai?.defaultThinkingOptionId).toBe("high");
  });

  test("restores the active provider after the sweep so goose keeps the user's default", async () => {
    const setSessionConfigOption = vi.fn(async ({ value }: { value: string }) =>
      providerResponse(value),
    );
    const client = createGooseClient(
      spawnWith(
        [providerConfigOption("ollama"), modelConfigOption("qwen3", OLLAMA_MODELS)],
        setSessionConfigOption,
      ),
    );

    await client.fetchCatalog({ scope: "workspace", cwd: "/tmp/acp-goose-restore", force: false });

    expect(setSessionConfigOption.mock.calls.map(([call]) => call)).toEqual([
      { sessionId: "session-1", configId: "provider", value: "ollama" },
      { sessionId: "session-1", configId: "provider", value: "openai" },
      { sessionId: "session-1", configId: "provider", value: "unconfigured" },
      { sessionId: "session-1", configId: "provider", value: "groq" },
      { sessionId: "session-1", configId: "provider", value: "ollama" },
    ]);
  });

  test("keeps the session models when goose offers no provider select", async () => {
    const setSessionConfigOption = vi.fn();
    const client = createGooseClient(
      spawnWith([modelConfigOption("qwen3", OLLAMA_MODELS)], setSessionConfigOption),
    );

    const catalog = await client.fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/acp-goose-no-provider",
      force: false,
    });

    expect(setSessionConfigOption).not.toHaveBeenCalled();
    expect(catalog.models.map((model) => model.id)).toEqual(["qwen3", "llama3"]);
  });
});

describe("writeGooseModel", () => {
  test("switches provider before model and returns the refreshed options", async () => {
    const setSessionConfigOption = vi.fn(
      async ({ configId, value }: { configId: string; value: string }) =>
        configId === "provider"
          ? providerResponse(value)
          : {
              configOptions: [
                providerConfigOption("openai"),
                modelConfigOption(value, OPENAI_MODELS),
              ],
            },
    );
    const connection = { setSessionConfigOption } as never;

    const result = await writeGooseModel(connection, "session-1", "openai/gpt-4o");

    expect(setSessionConfigOption.mock.calls.map(([call]) => call)).toEqual([
      { sessionId: "session-1", configId: "provider", value: "openai" },
      { sessionId: "session-1", configId: "model", value: "gpt-4o" },
    ]);
    expect(result.modelConfigId).toBe("model");
    expect(result.configOptions).toEqual([
      providerConfigOption("openai"),
      modelConfigOption("gpt-4o", OPENAI_MODELS),
    ]);
  });

  test("writes only the model when the id carries no provider", async () => {
    const setSessionConfigOption = vi.fn(async ({ value }: { value: string }) => ({
      configOptions: [modelConfigOption(value, OLLAMA_MODELS)],
    }));
    const connection = { setSessionConfigOption } as never;

    const result = await writeGooseModel(connection, "session-1", "qwen3");

    expect(setSessionConfigOption.mock.calls.map(([call]) => call)).toEqual([
      { sessionId: "session-1", configId: "model", value: "qwen3" },
    ]);
    expect(result.modelConfigId).toBe("model");
  });
});
