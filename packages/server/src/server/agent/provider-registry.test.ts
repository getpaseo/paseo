import { beforeEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentModelDefinition } from "./agent-sdk-types.js";

const mockState = vi.hoisted(() => {
  interface ConstructorEntry {
    runtimeSettings?: unknown;
    providerParams?: unknown;
  }

  return {
    constructorArgs: {
      claude: [] as ConstructorEntry[],
      codex: [] as ConstructorEntry[],
      copilot: [] as ConstructorEntry[],
      cursor: [] as Array<{
        command: string[];
        env?: Record<string, string>;
        providerParams?: unknown;
      }>,
      pi: [] as ConstructorEntry[],
      genericAcp: [] as Array<{
        command: string[];
        env?: Record<string, string>;
        providerId?: string;
        label?: string;
        providerParams?: unknown;
      }>,
    },
    isCommandAvailable: vi.fn(async (_command: string) => false),
    runtimeModels: new Map<string, AgentModelDefinition[]>(),
    reset() {
      this.constructorArgs.claude = [];
      this.constructorArgs.codex = [];
      this.constructorArgs.copilot = [];
      this.constructorArgs.cursor = [];
      this.constructorArgs.pi = [];
      this.constructorArgs.genericAcp = [];
      this.isCommandAvailable.mockReset();
      this.isCommandAvailable.mockImplementation(async (_command: string) => false);
      this.runtimeModels.clear();
    },
  };
});

vi.mock("../../executable-resolution/executable-resolution.js", () => ({
  isCommandAvailable: mockState.isCommandAvailable,
}));

vi.mock("./providers/claude/agent.js", () => ({
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
      const command: { mode?: string; argv?: string[] } | undefined =
        typeof this.runtimeSettings === "object" && this.runtimeSettings !== null
          ? Reflect.get(this.runtimeSettings, "command")
          : undefined;
      if (command?.mode === "replace") {
        const { isCommandAvailable } =
          await import("../../executable-resolution/executable-resolution.js");
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
      const command: { mode?: string; argv?: string[] } | undefined =
        typeof this.runtimeSettings === "object" && this.runtimeSettings !== null
          ? Reflect.get(this.runtimeSettings, "command")
          : undefined;
      if (command?.mode === "replace") {
        const { isCommandAvailable } =
          await import("../../executable-resolution/executable-resolution.js");
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
      const command: { mode?: string; argv?: string[] } | undefined =
        typeof this.runtimeSettings === "object" && this.runtimeSettings !== null
          ? Reflect.get(this.runtimeSettings, "command")
          : undefined;
      if (command?.mode === "replace") {
        const { isCommandAvailable } =
          await import("../../executable-resolution/executable-resolution.js");
        return await isCommandAvailable(command.argv?.[0] ?? "");
      }
      return true;
    }
  },
}));

vi.mock("./providers/pi/agent.js", () => ({
  PiRpcAgentClient: class PiRpcAgentClient {
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

    constructor(options: { runtimeSettings?: unknown; providerParams?: unknown }) {
      this.runtimeSettings = options.runtimeSettings;
      mockState.constructorArgs.pi.push({
        runtimeSettings: options.runtimeSettings,
        providerParams: options.providerParams,
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
    capabilities = {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    };
    readonly provider = "acp";
    readonly runtimeSettings?: unknown;

    constructor(options: {
      command: string[];
      env?: Record<string, string>;
      providerId?: string;
      label?: string;
      providerParams?: unknown;
    }) {
      const providerParams =
        options.providerParams &&
        typeof options.providerParams === "object" &&
        !Array.isArray(options.providerParams)
          ? (options.providerParams as Record<string, unknown>)
          : {};
      this.capabilities = {
        ...this.capabilities,
        supportsMcpServers:
          typeof providerParams.supportsMcpServers === "boolean"
            ? providerParams.supportsMcpServers
            : this.capabilities.supportsMcpServers,
      };
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
        providerId: options.providerId,
        label: options.label,
        providerParams: options.providerParams,
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

vi.mock("./providers/cursor-acp-agent.js", () => ({
  CursorACPAgentClient: class CursorACPAgentClient {
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

    constructor(options: {
      command: string[];
      env?: Record<string, string>;
      providerParams?: unknown;
    }) {
      this.runtimeSettings = {
        command: {
          mode: "replace",
          argv: options.command,
        },
        env: options.env,
      };
      mockState.constructorArgs.cursor.push({
        command: options.command,
        env: options.env,
        providerParams: options.providerParams,
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

import {
  AGENT_PROVIDER_DEFINITIONS,
  buildProviderRegistry,
  createAllClients,
} from "./provider-registry.js";

const logger = createTestLogger();

beforeEach(() => {
  mockState.reset();
});

test("builds registry with no overrides — same as built-in count", () => {
  const registry = buildProviderRegistry(logger);

  expect(Object.keys(registry)).toHaveLength(AGENT_PROVIDER_DEFINITIONS.length);
});

test("includes mock provider only for development builds", () => {
  expect(buildProviderRegistry(logger).mock).toBeUndefined();
  expect(buildProviderRegistry(logger, { isDev: false }).mock).toBeUndefined();

  const registry = buildProviderRegistry(logger, { isDev: true });

  expect(registry.mock).toMatchObject({
    id: "mock",
    label: "Mock Load Test",
    defaultModeId: "load-test",
  });
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

test("OMP is a disabled built-in backed by the Pi adapter", () => {
  const registry = buildProviderRegistry(logger);

  expect(registry.omp).toMatchObject({
    id: "omp",
    label: "OMP",
    enabled: false,
    derivedFromProviderId: null,
  });
  expect(registry.omp.createClient(logger).provider).toBe("omp");
  expect(mockState.constructorArgs.pi.at(-1)).toEqual({
    runtimeSettings: {
      command: {
        mode: "replace",
        argv: ["omp"],
      },
    },
    providerParams: {
      sessionDir: "~/.omp/agent/sessions",
    },
  });
});

test("OMP can be enabled without custom provider boilerplate", () => {
  const registry = buildProviderRegistry(logger, {
    providerOverrides: {
      omp: { enabled: true },
    },
  });

  expect(registry.omp.enabled).toBe(true);
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

test("new provider extending pi passes params to the base provider constructor", () => {
  const registry = buildProviderRegistry(logger, {
    providerOverrides: {
      omp: {
        extends: "pi",
        label: "OMP",
        command: ["omp"],
        params: {
          sessionDir: "~/.omp/agent/sessions",
        },
      },
    },
  });

  expect(registry.omp.createClient(logger).provider).toBe("omp");
  expect(mockState.constructorArgs.pi.at(-1)).toEqual({
    runtimeSettings: {
      command: {
        mode: "replace",
        argv: ["omp"],
      },
      env: undefined,
      disallowedTools: undefined,
    },
    providerParams: {
      sessionDir: "~/.omp/agent/sessions",
    },
  });
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
      providerId: "my-agent",
      label: "My Agent",
      providerParams: undefined,
    },
    {
      command: ["my-agent", "--acp"],
      env: {
        ACP_TOKEN: "secret",
      },
      providerId: "my-agent",
      label: "My Agent",
      providerParams: undefined,
    },
  ]);
});

test("ACP provider params can disable MCP support", () => {
  const registry = buildProviderRegistry(logger, {
    providerOverrides: {
      "no-mcp-acp": {
        extends: "acp",
        label: "No MCP ACP",
        command: ["no-mcp-acp", "serve"],
        params: {
          supportsMcpServers: false,
        },
      },
    },
  });

  const client = registry["no-mcp-acp"].createClient(logger);

  expect(client.capabilities.supportsMcpServers).toBe(false);
  expect(mockState.constructorArgs.genericAcp).toEqual([
    {
      command: ["no-mcp-acp", "serve"],
      env: undefined,
      providerId: "no-mcp-acp",
      label: "No MCP ACP",
      providerParams: {
        supportsMcpServers: false,
      },
    },
    {
      command: ["no-mcp-acp", "serve"],
      env: undefined,
      providerId: "no-mcp-acp",
      label: "No MCP ACP",
      providerParams: {
        supportsMcpServers: false,
      },
    },
  ]);
});

test("cursor provider extending acp uses CursorACPAgentClient", () => {
  const registry = buildProviderRegistry(logger, {
    providerOverrides: {
      cursor: {
        extends: "acp",
        label: "Cursor",
        command: ["cursor-agent", "acp"],
        env: {
          CURSOR_AGENT_LOG: "debug",
        },
      },
    },
  });

  expect(registry.cursor.createClient(logger).provider).toBe("cursor");
  expect(mockState.constructorArgs.cursor).toEqual([
    {
      command: ["cursor-agent", "acp"],
      env: {
        CURSOR_AGENT_LOG: "debug",
      },
      providerParams: undefined,
    },
    {
      command: ["cursor-agent", "acp"],
      env: {
        CURSOR_AGENT_LOG: "debug",
      },
      providerParams: undefined,
    },
  ]);
  expect(mockState.constructorArgs.genericAcp).toEqual([]);
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

test("enabled: false keeps provider metadata in registry", () => {
  const registry = buildProviderRegistry(logger, {
    providerOverrides: {
      claude: {
        enabled: false,
      },
    },
  });

  expect(registry.claude).toMatchObject({
    id: "claude",
    label: "Claude",
    description: "Anthropic's multi-tool assistant with MCP support, streaming, and deep reasoning",
    defaultModeId: "default",
    enabled: false,
  });
  expect(registry.claude.modes).toEqual(
    AGENT_PROVIDER_DEFINITIONS.find((definition) => definition.id === "claude")?.modes,
  );
  expect(registry.codex.enabled).toBe(true);
});

test("enabled: false still produces a client (enabled gate is enforced elsewhere)", () => {
  const clients = createAllClients(logger, {
    providerOverrides: {
      claude: {
        enabled: false,
      },
    },
  });

  expect(clients.claude).toBeDefined();
  expect(mockState.constructorArgs.claude.length).toBeGreaterThan(0);
  expect(clients.codex).toBeDefined();
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

  const zaiArgs = mockState.constructorArgs.claude.find((entry) => {
    const disallowedTools: string[] | undefined =
      typeof entry.runtimeSettings === "object" && entry.runtimeSettings !== null
        ? Reflect.get(entry.runtimeSettings, "disallowedTools")
        : undefined;
    return Array.isArray(disallowedTools) && disallowedTools.includes("ComputerUse");
  });
  expect(zaiArgs).toBeDefined();
  const zaiDisallowedTools: string[] =
    typeof zaiArgs!.runtimeSettings === "object" && zaiArgs!.runtimeSettings !== null
      ? Reflect.get(zaiArgs!.runtimeSettings, "disallowedTools")
      : [];
  expect(zaiDisallowedTools).toEqual(["WebSearch", "ComputerUse"]);
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
    mockState.constructorArgs.claude.every((entry) => {
      const command: { argv?: string[] } | undefined =
        typeof entry.runtimeSettings === "object" && entry.runtimeSettings !== null
          ? Reflect.get(entry.runtimeSettings, "command")
          : undefined;
      return command?.argv?.[0] === "/opt/custom-claude";
    }),
  ).toBe(true);
});

describe("model merging", () => {
  test("profile models replace runtime models", async () => {
    mockState.runtimeModels.set("codex", [
      {
        provider: "codex",
        id: "runtime-pro",
        label: "Runtime Pro",
      },
    ]);

    const registry = buildProviderRegistry(logger, {
      providerOverrides: {
        codex: {
          models: [
            {
              id: "profile-fast",
              label: "Profile Fast",
            },
          ],
        },
      },
    });

    const models = await registry.codex.fetchModels({
      cwd: "/tmp/registry-models",
      force: false,
    });

    expect(models.map((model) => model.id)).toEqual(["profile-fast"]);
  });

  test("profile models exclude runtime models entirely", async () => {
    mockState.runtimeModels.set("codex", [
      {
        provider: "codex",
        id: "shared-model",
        label: "Runtime Label",
      },
      {
        provider: "codex",
        id: "runtime-only",
        label: "Runtime Only",
      },
    ]);

    const registry = buildProviderRegistry(logger, {
      providerOverrides: {
        codex: {
          models: [
            {
              id: "shared-model",
              label: "Profile Label",
            },
          ],
        },
      },
    });

    const models = await registry.codex.fetchModels({
      cwd: "/tmp/registry-models",
      force: false,
    });

    expect(models).toEqual([
      {
        provider: "codex",
        id: "shared-model",
        label: "Profile Label",
      },
    ]);
  });

  test("profile isDefault preserved without runtime models", async () => {
    mockState.runtimeModels.set("codex", [
      {
        provider: "codex",
        id: "runtime-default",
        label: "Runtime Default",
        isDefault: true,
      },
    ]);

    const registry = buildProviderRegistry(logger, {
      providerOverrides: {
        codex: {
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

    const models = await registry.codex.fetchModels({
      cwd: "/tmp/registry-models",
      force: false,
    });

    expect(models).toEqual([
      {
        provider: "codex",
        id: "profile-default",
        label: "Profile Default",
        isDefault: true,
      },
    ]);
  });

  test("profile thinking option default is normalized onto the model", async () => {
    const registry = buildProviderRegistry(logger, {
      providerOverrides: {
        codex: {
          models: [
            {
              id: "profile-default",
              label: "Profile Default",
              isDefault: true,
              thinkingOptions: [
                { id: "off", label: "Off" },
                { id: "max", label: "Max", isDefault: true },
              ],
            },
          ],
        },
      },
    });

    const models = await registry.codex.fetchModels({
      cwd: "/tmp/registry-models",
      force: false,
    });

    expect(models).toEqual([
      {
        provider: "codex",
        id: "profile-default",
        label: "Profile Default",
        isDefault: true,
        thinkingOptions: [
          { id: "off", label: "Off" },
          { id: "max", label: "Max", isDefault: true },
        ],
        defaultThinkingOptionId: "max",
      },
    ]);
  });

  test("additional models append to runtime models", async () => {
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
          additionalModels: [
            {
              id: "profile-fast",
              label: "Profile Fast",
            },
          ],
        },
      },
    });

    const models = await registry.claude.fetchModels({
      cwd: "/tmp/registry-models",
      force: false,
    });

    expect(models).toEqual([
      {
        provider: "claude",
        id: "runtime-pro",
        label: "Runtime Pro",
      },
      {
        provider: "claude",
        id: "profile-fast",
        label: "Profile Fast",
      },
    ]);
  });

  test("built-in Claude profile models replace runtime models (issue #1299)", async () => {
    mockState.runtimeModels.set("claude", [
      {
        provider: "claude",
        id: "runtime-model",
        label: "Runtime Model",
      },
      {
        provider: "claude",
        id: "shared-model",
        label: "Runtime Label",
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
            {
              id: "profile-model",
              label: "Profile Model",
            },
          ],
        },
      },
    });

    const models = await registry.claude.fetchModels({
      cwd: "/tmp/registry-models",
      force: false,
    });

    expect(models).toEqual([
      {
        provider: "claude",
        id: "shared-model",
        label: "Profile Label",
      },
      {
        provider: "claude",
        id: "profile-model",
        label: "Profile Model",
      },
    ]);
  });

  test("additional models merge onto profile replacement models", async () => {
    mockState.runtimeModels.set("codex", [
      {
        provider: "codex",
        id: "runtime-pro",
        label: "Runtime Pro",
      },
    ]);

    const registry = buildProviderRegistry(logger, {
      providerOverrides: {
        codex: {
          models: [
            {
              id: "profile-curated",
              label: "Profile Curated",
            },
          ],
          additionalModels: [
            {
              id: "profile-extra",
              label: "Profile Extra",
            },
          ],
        },
      },
    });

    const models = await registry.codex.fetchModels({
      cwd: "/tmp/registry-models",
      force: false,
    });

    expect(models.map((model) => model.id)).toEqual(["profile-curated", "profile-extra"]);
  });

  test("additional models override matching runtime models in place", async () => {
    mockState.runtimeModels.set("claude", [
      {
        provider: "claude",
        id: "shared-model",
        label: "Runtime Label",
        description: "Runtime description",
        metadata: {
          source: "runtime",
        },
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
          additionalModels: [
            {
              id: "shared-model",
              label: "Profile Label",
            },
          ],
        },
      },
    });

    const models = await registry.claude.fetchModels({
      cwd: "/tmp/registry-models",
      force: false,
    });

    expect(models).toEqual([
      {
        provider: "claude",
        id: "shared-model",
        label: "Profile Label",
        description: "Runtime description",
        metadata: {
          source: "runtime",
        },
      },
      {
        provider: "claude",
        id: "runtime-only",
        label: "Runtime Only",
      },
    ]);
  });

  test("additional model default overrides runtime default", async () => {
    mockState.runtimeModels.set("claude", [
      {
        provider: "claude",
        id: "runtime-default",
        label: "Runtime Default",
        isDefault: true,
      },
      {
        provider: "claude",
        id: "runtime-other",
        label: "Runtime Other",
      },
    ]);

    const registry = buildProviderRegistry(logger, {
      providerOverrides: {
        claude: {
          additionalModels: [
            {
              id: "profile-default",
              label: "Profile Default",
              isDefault: true,
            },
          ],
        },
      },
    });

    const models = await registry.claude.fetchModels({
      cwd: "/tmp/registry-models",
      force: false,
    });

    expect(models).toEqual([
      {
        provider: "claude",
        id: "runtime-default",
        label: "Runtime Default",
        isDefault: false,
      },
      {
        provider: "claude",
        id: "runtime-other",
        label: "Runtime Other",
        isDefault: false,
      },
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
    const models = await registry.claude.fetchModels({
      cwd: "/tmp/registry-models",
      force: false,
    });

    expect(models).toEqual([
      {
        provider: "claude",
        id: "runtime-default",
        label: "Runtime Default",
        isDefault: true,
      },
    ]);
  });

  test("built-in createClient().listModels() honors profile model replacement (issue #579)", async () => {
    mockState.runtimeModels.set("codex", [
      {
        provider: "codex",
        id: "runtime-default",
        label: "Runtime Default",
        isDefault: true,
      },
    ]);

    const registry = buildProviderRegistry(logger, {
      providerOverrides: {
        codex: {
          models: [
            {
              id: "profile-fast",
              label: "Profile Fast",
              isDefault: true,
            },
          ],
        },
      },
    });

    const client = registry.codex.createClient(logger);
    const models = await client.listModels({
      cwd: "/tmp/registry-models",
      force: false,
    });

    expect(models.map((model) => model.id)).toEqual(["profile-fast"]);
    expect(models.find((model) => model.isDefault)?.id).toBe("profile-fast");
  });

  test("built-in createClient().listModels() honors additionalModels default (issue #579)", async () => {
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
          additionalModels: [
            {
              id: "profile-default",
              label: "Profile Default",
              isDefault: true,
            },
          ],
        },
      },
    });

    const client = registry.claude.createClient(logger);
    const models = await client.listModels({
      cwd: "/tmp/registry-models",
      force: false,
    });

    const defaultModel = models.find((model) => model.isDefault) ?? models[0];
    expect(defaultModel?.id).toBe("profile-default");
  });

  test("built-in Claude models override replaces hardcoded first-party models (issue #1299)", async () => {
    mockState.runtimeModels.set("claude", [
      { provider: "claude", id: "claude-opus-4-8", label: "Opus 4.8", isDefault: true },
      { provider: "claude", id: "claude-opus-4-7", label: "Opus 4.7" },
      { provider: "claude", id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
      { provider: "claude", id: "claude-haiku-4-5", label: "Haiku 4.5" },
    ]);

    const registry = buildProviderRegistry(logger, {
      providerOverrides: {
        claude: {
          models: [
            { id: "MiniMax-M2.7", label: "MiniMax-M2.7" },
            { id: "MiniMax-M3", label: "MiniMax-M3", isDefault: true },
          ],
        },
      },
    });

    const models = await registry.claude.fetchModels({
      cwd: "/tmp/registry-models",
      force: false,
    });

    expect(models.map((model) => model.id)).toEqual(["MiniMax-M2.7", "MiniMax-M3"]);
    expect(models.find((model) => model.isDefault)?.id).toBe("MiniMax-M3");
  });
});
