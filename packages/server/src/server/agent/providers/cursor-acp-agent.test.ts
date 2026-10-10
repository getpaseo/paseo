import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";

import { ACPAgentSession } from "./acp-agent.js";
import type { SpawnedACPProcess, SessionStateResponse } from "./acp-agent.js";
import type { AgentSessionConfig } from "../agent-sdk-types.js";
import { CURSOR_FAST_FEATURE_OPTION, CursorACPAgentClient } from "./cursor-acp-agent.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";

function captureWarnings(): {
  logger: ReturnType<typeof createTestLogger>;
  messages: () => string[];
} {
  const logged: string[] = [];
  const logger = createTestLogger();
  const child = {
    trace: vi.fn(),
    warn: (_context: unknown, message: string) => logged.push(message),
  };
  vi.spyOn(logger, "child").mockReturnValue(
    child as unknown as ReturnType<typeof createTestLogger>,
  );
  return { logger, messages: () => logged };
}

function fastConfigOption(currentValue: "false" | "true"): SessionConfigOption {
  return {
    id: "fast",
    name: "Fast",
    type: "select",
    currentValue,
    options: [
      { value: "false", name: "Off" },
      { value: "true", name: "Fast" },
    ],
  };
}

describe("CursorACPAgentClient model discovery", () => {
  class TestCursorACPAgentClient extends CursorACPAgentClient {
    constructor(response: SessionStateResponse) {
      super({
        logger: createTestLogger(),
        command: ["cursor-agent", "acp"],
      });
      this.response = response;
    }

    private readonly response: SessionStateResponse;

    protected override async spawnProcess(): Promise<SpawnedACPProcess> {
      return {
        child: { kill: vi.fn(), exitCode: 0, signalCode: null, once: vi.fn() },
        connection: {
          newSession: vi.fn().mockResolvedValue(this.response),
          extMethod: async () => ({
            models: (this.response.models?.availableModels ?? []).map((model) => ({
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
});

describe("CursorACPAgentClient session start", () => {
  // Kimi K3 exposes reasoning but no fast option.
  const KIMI_K3_CONFIG_OPTIONS: SessionConfigOption[] = [
    {
      id: "reasoning",
      name: "Reasoning",
      category: "thought_level",
      type: "select",
      currentValue: "max",
      options: [
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
        { value: "max", name: "Max" },
      ],
    },
  ];

  function createCursorSession(
    config: Partial<AgentSessionConfig>,
    session: {
      currentModelId: string;
      configOptions: SessionConfigOption[];
      setSessionConfigOption?: () => Promise<{ configOptions: SessionConfigOption[] }>;
    } = { currentModelId: "kimi-k3", configOptions: KIMI_K3_CONFIG_OPTIONS },
    logger = createTestLogger(),
  ): ACPAgentSession {
    class StubbedCursorSession extends ACPAgentSession {
      protected override async spawnProcess(): Promise<SpawnedACPProcess> {
        return {
          child: { kill: vi.fn(), exitCode: 0, signalCode: null, once: vi.fn() },
          connection: {
            newSession: vi.fn().mockResolvedValue({
              sessionId: "session-1",
              models: {
                currentModelId: session.currentModelId,
                availableModels: [
                  { modelId: "composer-2.5", name: "Composer 2.5", description: null },
                  { modelId: "kimi-k3", name: "Kimi K3", description: null },
                ],
              },
              configOptions: session.configOptions,
            }),
            // cursor-agent switches the model without returning refreshed config options.
            unstable_setSessionModel: vi.fn().mockResolvedValue(undefined),
            setSessionConfigOption:
              session.setSessionConfigOption ??
              vi.fn().mockResolvedValue({ configOptions: session.configOptions }),
          },
          initialize: { agentCapabilities: {} },
        } as SpawnedACPProcess;
      }
    }

    return new StubbedCursorSession(
      { provider: "acp", cwd: "/tmp/cursor", ...config },
      {
        provider: "acp",
        logger,
        defaultCommand: ["cursor-agent", "acp"],
        defaultModes: [],
        capabilities: { supportsStreaming: true, supportsSessionPersistence: true },
        configFeatureOptions: [CURSOR_FAST_FEATURE_OPTION],
      },
    );
  }

  test("starts on a model without a fast variant while Fast is still stored", async () => {
    // The composer stored Fast while a fast-capable model was selected, and it is
    // still stored after the draft moved to a model that has no fast variant.
    const warn = captureWarnings();
    const session = createCursorSession(
      { model: "kimi-k3", featureValues: { [CURSOR_FAST_FEATURE_OPTION.id]: "true" } },
      { currentModelId: "kimi-k3", configOptions: KIMI_K3_CONFIG_OPTIONS },
      warn.logger,
    );

    await session.initializeNewSession();

    expect(session.id).toBe("session-1");
    expect(warn.messages()).toContain(
      "acp cannot apply ACP feature 'fast' to the current model; using the provider default",
    );
  });

  test("starts when the CLI rejects a stored feature the switched-to model dropped", async () => {
    // The CLI keeps the pre-switch config options for the session, so Fast is
    // still listed after the model moves to one that has no fast variant.
    const warn = captureWarnings();
    const session = createCursorSession(
      { model: "kimi-k3", featureValues: { [CURSOR_FAST_FEATURE_OPTION.id]: "true" } },
      {
        currentModelId: "composer-2.5",
        configOptions: [fastConfigOption("false"), ...KIMI_K3_CONFIG_OPTIONS],
        setSessionConfigOption: vi.fn().mockRejectedValue(
          Object.assign(new Error("Invalid params"), {
            code: -32602,
            data: { message: "Unknown model config option: fast" },
          }),
        ),
      },
      warn.logger,
    );

    await session.initializeNewSession();

    expect(session.id).toBe("session-1");
    expect(warn.messages()).toContain(
      "acp cannot apply ACP feature 'fast' to the current model; using the provider default",
    );
  });

  test("still fails session start when a stored feature write fails for another reason", async () => {
    const session = createCursorSession(
      { model: "kimi-k3", featureValues: { [CURSOR_FAST_FEATURE_OPTION.id]: "true" } },
      {
        currentModelId: "composer-2.5",
        configOptions: [fastConfigOption("false"), ...KIMI_K3_CONFIG_OPTIONS],
        setSessionConfigOption: vi.fn().mockRejectedValue(new Error("write EPIPE")),
      },
    );

    await expect(session.initializeNewSession()).rejects.toThrow("write EPIPE");
  });

  test("reports the failure when the user turns Fast on for a model without it", async () => {
    const session = createCursorSession({ model: "kimi-k3" });
    await session.initializeNewSession();

    await expect(session.setFeature(CURSOR_FAST_FEATURE_OPTION.id, "true")).rejects.toThrow(
      "acp does not expose ACP feature 'fast'",
    );
  });

  test("still fails session start when the provider rejects a write it should accept", async () => {
    // No model switch, so the session's options came straight from session/new and the
    // provider disagreeing about a feature it just advertised is a real failure.
    const session = createCursorSession(
      { model: "composer-2.5", featureValues: { [CURSOR_FAST_FEATURE_OPTION.id]: "true" } },
      {
        currentModelId: "composer-2.5",
        configOptions: [fastConfigOption("false")],
        setSessionConfigOption: vi.fn().mockRejectedValue(
          Object.assign(new Error("Invalid params"), {
            code: -32602,
            data: { message: "sessionId is required" },
          }),
        ),
      },
    );

    await expect(session.initializeNewSession()).rejects.toThrow("Invalid params");
  });
});

describe("CursorACPAgentClient usage session", () => {
  test("matches usage sources as cursor, with the agent's provider and launch env", async () => {
    await withFakeACPAgent(async (command, cwd) => {
      const client = new CursorACPAgentClient({
        logger: createTestLogger(),
        command,
        env: { XDG_CONFIG_HOME: "/profile/config" },
      });
      const session = await client.createSession(
        { provider: "acp", cwd },
        { agentId: "agent-1", env: { HOME: "/agent/home" } },
      );
      const usage = session.usageSession?.();
      expect(usage).toMatchObject({
        provider: "cursor",
        env: { XDG_CONFIG_HOME: "/profile/config", HOME: "/agent/home" },
      });
      expect(session.usageSession?.()?.sessionKey).toBe(usage?.sessionKey);
      await session.close();
      expect(session.usageSession?.()).toBeNull();
    });
  });

  test("leaves other ACP agents without a usage session", async () => {
    await withFakeACPAgent(async (command, cwd) => {
      const client = new GenericACPAgentClient({ logger: createTestLogger(), command });
      const session = await client.createSession({ provider: "acp", cwd });
      try {
        expect(session.usageSession?.()).toBeNull();
      } finally {
        await session.close();
      }
    });
  });
});

async function withFakeACPAgent(
  run: (command: [string, ...string[]], cwd: string) => Promise<void>,
): Promise<void> {
  const testDir = await mkdtemp(path.join(tmpdir(), "paseo-cursor-usage-"));
  try {
    const scriptPath = path.join(testDir, "fake-acp-agent.cjs");
    await writeFile(scriptPath, fakeACPAgentScript, "utf8");
    await run([process.execPath, scriptPath], testDir);
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
}

const fakeACPAgentScript = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function write(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
}
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    write({ id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? 1, agentCapabilities: {} } });
  } else if (message.method === "session/new") {
    write({ id: message.id, result: { sessionId: "session-1" } });
  } else if (message.id !== undefined) {
    write({ id: message.id, result: {} });
  }
});
`;
