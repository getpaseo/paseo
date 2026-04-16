import { beforeEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentModelDefinition } from "./agent-sdk-types.js";

const mockState = vi.hoisted(() => {
  type ConstructorEntry = {
    runtimeSettings?: unknown;
  };

  return {
    constructorArgs: {
      claude: [] as ConstructorEntry[],
      codex: [] as ConstructorEntry[],
      copilot: [] as ConstructorEntry[],
      opencode: [] as ConstructorEntry[],
      pi: [] as ConstructorEntry[],
      genericAcp: [] as Array<{
        command: string[];
        env?: Record<string, string>;
      }>,
    },
    isCommandAvailable: vi.fn(async (_command: string) => false),
    runtimeModels: new Map<string, AgentModelDefinition[]>(),
    reset() {
      for (const key of Object.keys(this.constructorArgs) as Array<
        keyof typeof this.constructorArgs
      >) {
        this.constructorArgs[key] = [];
      }
      this.isCommandAvailable.mockReset();
      this.isCommandAvailable.mockImplementation(async (_command: string) => false);
      this.runtimeModels.clear();
    },
  };
});

vi.mock("../../utils/executable.js", () => ({
  isCommandAvailable: mockState.isCommandAvailable,
}));

vi.mock("./providers/claude-agent.js", () => ({
  ClaudeAgentClient: class ClaudeAgentClient {
    readonly capabilities = {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    };
    readonly provider = "claude";
    readonly runtimeSettings?: unknown;

    constructor(options: { runtimeSettings?: unknown }) {
      this.runtimeSettings = options.runtimeSettings;
      mockState.constructorArgs.claude.push({
        runtimeSettings: options.runtimeSettings,
      });
    }

    async createSession(): Promise<never> {
      throw new Error("not implemented");
    }

    async resumeSession(): Promise<never> {
      throw new Error("not implemented");
    }

    async listModels(): Promise<AgentModelDefinition[]> {
      return mockState.runtimeModels.get(this.provider) ?? [];
    }

    async listModes(): Promise<[]> {
      return [];
    }

    async isAvailable(): Promise<boolean> {
      const command = (this.runtimeSettings as { command?: { mode?: string; argv?: string[] } })
        ?.command;
      if (command?.mode === "replace") {
        const { isCommandAvailable } = await import("../../utils/executable.js");
        return await isCommandAvailable(command.argv?.[0] ?? "");
      }
      return true;
    }
  },
}));

vi.mock("./providers/codex-app-server-agent.js", () => ({
  CodexAppServerAgentClient: class CodexAppServerAgentClient {
    readonly capabilities = {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    };
    readonly provider = "codex";
    readonly runtimeSettings?: unknown;

    constructor(_logger: unknown, runtimeSettings?: unknown) {
      this.runtimeSettings = runtimeSettings;
      mockState.constructorArgs.codex.push({ runtimeSettings });
    }

    async createSession(): Promise<never> {
      throw new Error("not implemented");
    }

    async resumeSession(): Promise<never> {
      throw new Error("not implemented");
    }

    async listModels(): Promise<AgentModelDefinition[]> {
      return mockState.runtimeModels.get(this.provider) ?? [];
    }

    async listModes(): Promise<[]> {
      return [];
    }

    async isAvailable(): Promise<boolean> {
      const command = (this.runtimeSettings as { command?: { mode?: string; argv?: string[] } })
        ?.command;
      if (command?.mode === "replace") {
        const { isCommandAvailable } = await import("../../utils/executable.js");
        return await isCommandAvailable(command.argv?.[0] ?? "");
      }
      return true;
    }
  },
}));

vi.mock("./providers/copilot-acp-agent.js", () => ({
  CopilotACPAgentClient: class CopilotACPAgentClient {
    readonly capabilities = {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    };
    readonly provider = "copilot";
    readonly runtimeSettings?: unknown;

    constructor(options: { runtimeSettings?: unknown }) {
      this.runtimeSettings = options.runtimeSettings;
      mockState.constructorArgs.copilot.push({
        runtimeSettings: options.runtimeSettings,
      });
    }

    async createSession(): Promise<never> {
      throw new Error("not implemented");
    }

    async resumeSession(): Promise<never> {
      throw new Error("not implemented");
    }

    async listModels(): Promise<AgentModelDefinition[]> {
      return mockState.runtimeModels.get(this.provider) ?? [];
    }

    async listModes(): Promise<[]> {
      return [];
    }

    async isAvailable(): Promise<boolean> {
      const command = (this.runtimeSettings as { command?: { mode?: string; argv?: string[] } })
        ?.command;
      if (command?.mode === "replace") {
        const { isCommandAvailable } = await import("../../utils/executable.js");
        return await isCommandAvailable(command.argv?.[0] ?? "");
      }
      return true;
    }
  },
}));

vi.mock("./providers/opencode-agent.js", () => ({
  OpenCodeAgentClient: class OpenCodeAgentClient {
    readonly capabilities = {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    };
    readonly provider = "opencode";
    readonly runtimeSettings?: unknown;

    constructor(_logger: unknown, runtimeSettings?: unknown) {
      this.runtimeSettings = runtimeSettings;
      mockState.constructorArgs.opencode.push({ runtimeSettings });
    }

    async createSession(): Promise<never> {
      throw new Error("not implemented");
    }

    async resumeSession(): Promise<never> {
      throw new Error("not implemented");
    }

    async listModels(): Promise<AgentModelDefinition[]> {
      return mockState.runtimeModels.get(this.provider) ?? [];
    }

    async listModes(): Promise<[]> {
      return [];
    }

    async isAvailable(): Promise<boolean> {
      return true;
    }
  },
  OpenCodeServerManager: {
    getInstance: vi.fn(() => ({
      shutdown: vi.fn(),
    })),
  },
}));

vi.mock("./providers/pi-acp-agent.js", () => ({
  PiACPAgentClient: class PiACPAgentClient {
    readonly capabilities = {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    };
    readonly provider = "pi";
    readonly runtimeSettings?: unknown;

    constructor(options: { runtimeSettings?: unknown }) {
      this.runtimeSettings = options.runtimeSettings;
      mockState.constructorArgs.pi.push({
        runtimeSettings: options.runtimeSettings,
      });
    }

    async createSession(): Promise<never> {
      throw new Error("not implemented");
    }

    async resumeSession(): Promise<never> {
      throw new Error("not implemented");
    }

    async listModels(): Promise<AgentModelDefinition[]> {
      return mockState.runtimeModels.get(this.provider) ?? [];
    }

    async listModes(): Promise<[]> {
      return [];
    }

    async isAvailable(): Promise<boolean> {
      return true;
    }
  },
}));

vi.mock("./providers/generic-acp-agent.js", () => ({
  GenericACPAgentClient: class GenericACPAgentClient {
    readonly capabilities = {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    };
    readonly provider = "acp";
    readonly runtimeSettings?: unknown;

    constructor(options: { command: string[]; env?: Record<string, string> }) {
      this.runtimeSettings = {
        command: {
          mode: "replace",
          argv: options.command,
        },
        env: options.env,
      };
      mockState.constructorArgs.genericAcp.push({
        command: options.command,
        env: options.env,
      });
    }

    async createSession(): Promise<never> {
      throw new Error("not implemented");
    }

    async resumeSession(): Promise<never> {
      throw new Error("not implemented");
    }

    async listModels(): Promise<AgentModelDefinition[]> {
      return mockState.runtimeModels.get(this.provider) ?? [];
    }

    async listModes(): Promise<[]> {
      return [];
    }

    async isAvailable(): Promise<boolean> {
      return true;
    }
  },
}));

import { AGENT_PROVIDER_DEFINITIONS, buildProviderRegistry } from "./provider-registry.js";

describe("buildProviderRegistry", () => {
  const logger = createTestLogger();

  beforeEach(() => {
    mockState.reset();
  });

  test("builds registry with no overrides — same as built-in count", () => {
    const registry = buildProviderRegistry(logger);

    expect(Object.keys(registry)).toHaveLength(AGENT_PROVIDER_DEFINITIONS.length);
  });

  test("built-in override applies command", () => {
    buildProviderRegistry(logger, {
      providerOverrides: {
        claude: {
          command: ["/opt/custom-claude", "--verbose"],
        },
      },
    });

    expect(mockState.constructorArgs.claude[0]).toEqual({
      runtimeSettings: {
        command: {
          mode: "replace",
          argv: ["/opt/custom-claude", "--verbose"],
        },
        env: undefined,
      },
    });
  });

  test("built-in override applies env", () => {
    buildProviderRegistry(logger, {
      providerOverrides: {
        claude: {
          env: {
            CLAUDE_CONFIG_DIR: "/tmp/claude",
          },
        },
      },
    });

    expect(mockState.constructorArgs.claude[0]).toEqual({
      runtimeSettings: {
        command: undefined,
        env: {
          CLAUDE_CONFIG_DIR: "/tmp/claude",
        },
      },
    });
  });

  test("new provider extending claude appears in registry", () => {
    const registry = buildProviderRegistry(logger, {
      providerOverrides: {
        zai: {
          extends: "claude",
          label: "ZAI",
          description: "Claude with ZAI defaults",
        },
      },
    });

    expect(registry.zai).toBeDefined();
    expect(registry.zai.label).toBe("ZAI");
    expect(registry.zai.description).toBe("Claude with ZAI defaults");
    expect(registry.zai.createClient(logger).provider).toBe("zai");
  });

  test("new provider extending acp uses GenericACPAgentClient", () => {
    const registry = buildProviderRegistry(logger, {
      providerOverrides: {
        "my-agent": {
          extends: "acp",
          label: "My Agent",
          command: ["my-agent", "--acp"],
          env: {
            ACP_TOKEN: "secret",
          },
        },
      },
    });

    expect(registry["my-agent"].createClient(logger).provider).toBe("my-agent");
    expect(mockState.constructorArgs.genericAcp).toEqual([
      {
        command: ["my-agent", "--acp"],
        env: {
          ACP_TOKEN: "secret",
        },
      },
      {
        command: ["my-agent", "--acp"],
        env: {
          ACP_TOKEN: "secret",
        },
      },
    ]);
  });

  test('extends: "acp" without command throws', () => {
    expect(() =>
      buildProviderRegistry(logger, {
        providerOverrides: {
          "my-agent": {
            extends: "acp",
            label: "My Agent",
          },
        },
      }),
    ).toThrowError("ACP provider 'my-agent' requires a command");
  });

  test("custom provider without label throws", () => {
    expect(() =>
      buildProviderRegistry(logger, {
        providerOverrides: {
          zai: {
            extends: "claude",
          },
        },
      }),
    ).toThrowError("Custom provider 'zai' requires a label");
  });

  test("enabled: false excludes provider from registry", () => {
    const registry = buildProviderRegistry(logger, {
      providerOverrides: {
        claude: {
          enabled: false,
        },
      },
    });

    expect(registry.claude).toBeUndefined();
  });

  test("provider override command can be PATH-resolved and still report available", async () => {
    mockState.isCommandAvailable.mockResolvedValue(true);

    const registry = buildProviderRegistry(logger, {
      providerOverrides: {
        claude: {
          command: ["claude", "--flag"],
        },
      },
    });

    await expect(registry.claude.createClient(logger).isAvailable()).resolves.toBe(true);
    expect(mockState.isCommandAvailable).toHaveBeenCalledWith("claude");
  });

  test("disallowedTools flows through to runtime settings", () => {
    buildProviderRegistry(logger, {
      providerOverrides: {
        claude: {
          disallowedTools: ["WebSearch", "WebFetch"],
        },
      },
    });

    expect(mockState.constructorArgs.claude[0]).toEqual({
      runtimeSettings: {
        command: undefined,
        env: undefined,
        disallowedTools: ["WebSearch", "WebFetch"],
      },
    });
  });

  test("derived provider inherits and merges disallowedTools from base", () => {
    buildProviderRegistry(logger, {
      providerOverrides: {
        claude: {
          disallowedTools: ["WebSearch"],
        },
        zai: {
          extends: "claude",
          label: "ZAI",
          disallowedTools: ["ComputerUse"],
        },
      },
    });

    const zaiArgs = mockState.constructorArgs.claude.find(
      (entry) =>
        Array.isArray((entry.runtimeSettings as { disallowedTools?: string[] })?.disallowedTools) &&
        (entry.runtimeSettings as { disallowedTools: string[] }).disallowedTools.includes(
          "ComputerUse",
        ),
    );
    expect(zaiArgs).toBeDefined();
    expect((zaiArgs!.runtimeSettings as { disallowedTools: string[] }).disallowedTools).toEqual([
      "WebSearch",
      "ComputerUse",
    ]);
  });

  test("extension inherits base override — override claude command, zai extends claude gets overridden command", () => {
    buildProviderRegistry(logger, {
      providerOverrides: {
        claude: {
          command: ["/opt/custom-claude"],
        },
        zai: {
          extends: "claude",
          label: "ZAI",
        },
      },
    });

    expect(mockState.constructorArgs.claude).toHaveLength(2);
    expect(
      mockState.constructorArgs.claude.every(
        (entry) =>
          (entry.runtimeSettings as { command?: { argv?: string[] } }).command?.argv?.[0] ===
          "/opt/custom-claude",
      ),
    ).toBe(true);
  });

  describe("model merging", () => {
    test("profile models replace runtime models", async () => {
      mockState.runtimeModels.set("claude", [
        {
          provider: "claude",
          id: "runtime-pro",
          label: "Runtime Pro",
        },
      ]);

      const registry = buildProviderRegistry(logger, {
        providerOverrides: {
          claude: {
            models: [
              {
                id: "profile-fast",
                label: "Profile Fast",
              },
            ],
          },
        },
      });

      const models = await registry.claude.fetchModels();

      expect(models.map((model) => model.id)).toEqual(["profile-fast"]);
    });

    test("profile models exclude runtime models entirely", async () => {
      mockState.runtimeModels.set("claude", [
        {
          provider: "claude",
          id: "shared-model",
          label: "Runtime Label",
        },
        {
          provider: "claude",
          id: "runtime-only",
          label: "Runtime Only",
        },
      ]);

      const registry = buildProviderRegistry(logger, {
        providerOverrides: {
          claude: {
            models: [
              {
                id: "shared-model",
                label: "Profile Label",
              },
            ],
          },
        },
      });

      const models = await registry.claude.fetchModels();

      expect(models).toEqual([
        {
          provider: "claude",
          id: "shared-model",
          label: "Profile Label",
        },
      ]);
    });

    test("profile isDefault preserved without runtime models", async () => {
      mockState.runtimeModels.set("claude", [
        {
          provider: "claude",
          id: "runtime-default",
          label: "Runtime Default",
          isDefault: true,
        },
      ]);

      const registry = buildProviderRegistry(logger, {
        providerOverrides: {
          claude: {
            models: [
              {
                id: "profile-default",
                label: "Profile Default",
                isDefault: true,
              },
            ],
          },
        },
      });

      const models = await registry.claude.fetchModels();

      expect(models).toEqual([
        {
          provider: "claude",
          id: "profile-default",
          label: "Profile Default",
          isDefault: true,
        },
      ]);
    });

    test("no profile models — runtime models returned as-is", async () => {
      mockState.runtimeModels.set("claude", [
        {
          provider: "claude",
          id: "runtime-default",
          label: "Runtime Default",
          isDefault: true,
        },
      ]);

      const registry = buildProviderRegistry(logger);
      const models = await registry.claude.fetchModels();

      expect(models).toEqual([
        {
          provider: "claude",
          id: "runtime-default",
          label: "Runtime Default",
          isDefault: true,
        },
      ]);
    });
  });
});
