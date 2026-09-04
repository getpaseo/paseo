import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ToolPolicy } from "@getpaseo/protocol/agent-types";
import express from "express";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type {
  AgentFeature,
  AgentModelDefinition,
  AgentSessionConfig,
  ProviderCatalog,
} from "./agent-sdk-types.js";

const CLAUDE_CUSTOM_THINKING_FIELDS = {
  thinkingOptions: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High", isDefault: true },
    { id: "max", label: "Max" },
  ],
  defaultThinkingOptionId: "high",
} satisfies Partial<AgentModelDefinition>;

const mockState = vi.hoisted(() => {
  interface ConstructorEntry {
    runtimeSettings?: unknown;
    providerParams?: unknown;
    commandsRpcType?: unknown;
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
      trae: [] as Array<{
        command: string[];
        env?: Record<string, string>;
        providerParams?: unknown;
      }>,
      kimi: [] as Array<{
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
    resolveCodexDefaultModeId: vi.fn(async () => undefined as string | undefined),
    runtimeModels: new Map<string, AgentModelDefinition[]>(),
    cursorListFeaturesConfigs: [] as AgentSessionConfig[],
    reset() {
      this.constructorArgs.claude = [];
      this.constructorArgs.codex = [];
      this.constructorArgs.copilot = [];
      this.constructorArgs.cursor = [];
      this.constructorArgs.trae = [];
      this.constructorArgs.kimi = [];
      this.constructorArgs.pi = [];
      this.constructorArgs.genericAcp = [];
      this.isCommandAvailable.mockReset();
      this.isCommandAvailable.mockImplementation(async (_command: string) => false);
      this.resolveCodexDefaultModeId.mockReset();
      this.resolveCodexDefaultModeId.mockImplementation(async () => undefined);
      this.runtimeModels.clear();
      this.cursorListFeaturesConfigs = [];
    },
  };
});

vi.mock("../../executable-resolution/executable-resolution.js", () => ({
  isCommandAvailable: mockState.isCommandAvailable,
}));

vi.mock("./providers/claude/agent.js", async () => {
  const { resolveConfiguredClaudeModel } = await import("./providers/claude/models.js");
  return {
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

      async fetchCatalog(): Promise<ProviderCatalog> {
        return {
          models: mockState.runtimeModels.get(this.provider) ?? [],
          modes: [],
        };
      }

      async resolveDefaultModeId(input: unknown): Promise<string | undefined> {
        return await mockState.resolveCodexDefaultModeId(input);
      }

      resolveConfiguredModel(model: AgentModelDefinition): AgentModelDefinition {
        return resolveConfiguredClaudeModel(model);
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
  };
});

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

    async fetchCatalog(): Promise<ProviderCatalog> {
      return {
        models: mockState.runtimeModels.get(this.provider) ?? [],
        modes: [],
      };
    }

    async resolveDefaultModeId(input: unknown): Promise<string | undefined> {
      return await mockState.resolveCodexDefaultModeId(input);
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

    async fetchCatalog(): Promise<ProviderCatalog> {
      return {
        models: mockState.runtimeModels.get(this.provider) ?? [],
        modes: [],
      };
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

    constructor(options: {
      runtimeSettings?: unknown;
      providerParams?: unknown;
      commandsRpcType?: unknown;
    }) {
      this.runtimeSettings = options.runtimeSettings;
      const entry: ConstructorEntry = {
        runtimeSettings: options.runtimeSettings,
        providerParams: options.providerParams,
      };
      if (options.commandsRpcType !== undefined) {
        entry.commandsRpcType = options.commandsRpcType;
      }
      mockState.constructorArgs.pi.push(entry);
    }

    async createSession(): Promise<never> {
      throw new Error("not implemented");
    }

    async resumeSession(): Promise<never> {
      throw new Error("not implemented");
    }

    async fetchCatalog(): Promise<ProviderCatalog> {
      return {
        models: mockState.runtimeModels.get(this.provider) ?? [],
        modes: [],
      };
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

    async fetchCatalog(): Promise<ProviderCatalog> {
      return {
        models: mockState.runtimeModels.get(this.provider) ?? [],
        modes: [],
      };
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

    async fetchCatalog(): Promise<ProviderCatalog> {
      return {
        models: mockState.runtimeModels.get(this.provider) ?? [],
        modes: [],
      };
    }

    async isAvailable(): Promise<boolean> {
      return true;
    }

    async listFeatures(config: AgentSessionConfig): Promise<AgentFeature[]> {
      mockState.cursorListFeaturesConfigs.push(config);
      return [
        {
          type: "select",
          id: "fast",
          label: "Fast",
          value: "false",
          options: [{ id: "false", label: "Off" }],
        },
      ];
    }
  },
}));

vi.mock("./providers/trae-acp-agent.js", () => ({
  TraeACPAgentClient: class TraeACPAgentClient {
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
      mockState.constructorArgs.trae.push({
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

    async fetchCatalog(): Promise<ProviderCatalog> {
      return {
        models: mockState.runtimeModels.get(this.provider) ?? [],
        modes: [],
      };
    }

    async isAvailable(): Promise<boolean> {
      return true;
    }
  },
}));

vi.mock("./providers/kimi-acp-agent.js", () => ({
  KimiACPAgentClient: class KimiACPAgentClient {
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
      mockState.constructorArgs.kimi.push({
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

    async fetchCatalog(): Promise<ProviderCatalog> {
      return {
        models: mockState.runtimeModels.get(this.provider) ?? [],
        modes: [],
      };
    }

    async isAvailable(): Promise<boolean> {
      return true;
    }
  },
}));

import {
  AGENT_PROVIDER_DEFINITIONS,
  buildProviderRegistry,
  type ProviderDefinition,
} from "./provider-registry.js";
import { ProviderRuntime } from "./provider-connection-runtime.js";
import { FakeOmp } from "./providers/omp/test-utils/fake-omp.js";

const logger = createTestLogger();

async function fetchBoundaryCatalog(definition: ProviderDefinition, options: { cwd?: string }) {
  const runtime = new ProviderRuntime(definition.registration);
  try {
    const catalog = await runtime.catalog(options.cwd);
    expect(catalog.models.every((model) => !("provider" in model))).toBe(true);
    return {
      ...catalog,
      models: catalog.models.map((model) => Object.assign({}, model, { provider: definition.id })),
    };
  } finally {
    await runtime.close();
  }
}

async function openBoundarySession(
  definition: ProviderDefinition,
  cwd: string,
  mcpServers: AgentSessionConfig["mcpServers"] = {},
) {
  const runtime = new ProviderRuntime(definition.registration);
  await runtime.openSession({
    sessionId: "registry-test",
    config: { cwd, env: {}, mcpServers, settings: {}, persist: false },
    history: "skip",
  });
  return runtime;
}

async function startOmpMcpTestServer(): Promise<{ url: string; close(): Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.post("/mcp/agents", (request, response) => {
    void (async () => {
      const server = new McpServer({ name: "omp-registry-test", version: "1.0.0" });
      server.registerTool(
        "create_agent",
        {
          description: "Create a Paseo agent.",
          inputSchema: { prompt: z.string() },
        },
        async ({ prompt }) => ({ content: [{ type: "text", text: `created: ${prompt}` }] }),
      );
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      response.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(
        request as unknown as IncomingMessage,
        response as unknown as ServerResponse,
        request.body,
      );
    })().catch((error: unknown) => {
      if (!response.headersSent) response.status(500).send(String(error));
    });
  });
  const httpServer = createHttpServer(app);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("OMP MCP test server did not bind");
  return {
    url: `http://127.0.0.1:${address.port}/mcp/agents`,
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

beforeEach(() => {
  mockState.reset();
});

test("builds registry with no overrides — same as built-in count", () => {
  const registry = buildProviderRegistry(logger);

  expect(Object.keys(registry)).toHaveLength(AGENT_PROVIDER_DEFINITIONS.length);
  expect(registry.codex).not.toHaveProperty("optionsSchema");
  expect(registry.codex).not.toHaveProperty("validateOptions");
  expect(registry.codex).not.toHaveProperty("resolveCreateConfig");
  expect(registry.codex).not.toHaveProperty("isCreateConfigUnattended");
  expect(registry.codex).not.toHaveProperty("getDiagnostic");
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

test("OMP is a disabled built-in backed by the real OMP adapter", async () => {
  const omp = new FakeOmp();
  const registry = buildProviderRegistry(logger, { ompRuntime: omp });
  const mcp = await startOmpMcpTestServer();

  expect(registry.omp).toMatchObject({
    id: "omp",
    label: "Oh My Pi",
    enabled: false,
    derivedFromProviderId: null,
  });
  expect(registry.omp.registration.id).toBe("omp");
  const runtime = await openBoundarySession(registry.omp, "/tmp/registry-omp", {
    paseo: { type: "http", url: mcp.url },
  });
  try {
    expect(omp.recordedLaunches).toEqual([
      expect.objectContaining({
        cwd: "/tmp/registry-omp",
        protocolMode: "rpc-ui",
        argv: ["omp", "--mode", "rpc-ui", "--approval-mode", "yolo"],
      }),
    ]);
    expect(omp.latestSession().hostToolSetRequests).toEqual([
      [expect.objectContaining({ name: "create_agent", loadMode: "essential" })],
    ]);
    const hostToolResult = omp.latestSession().nextHostToolResult();
    omp.latestSession().emit({
      type: "host_tool_call",
      id: "host-call-1",
      toolCallId: "tool-call-1",
      toolName: "create_agent",
      arguments: { prompt: "from OMP" },
    });
    await expect(hostToolResult).resolves.toMatchObject({
      id: "host-call-1",
      result: { content: [{ type: "text", text: "created: from OMP" }] },
    });
  } finally {
    await runtime.close();
    await mcp.close();
  }
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
  expect(registry.zai.registration.id).toBe("zai");
});

test("built-in OMP override keeps the real OMP adapter enabled and launchable", async () => {
  const omp = new FakeOmp(["custom-omp"]);
  const registry = buildProviderRegistry(logger, {
    ompRuntime: omp,
    providerOverrides: {
      omp: {
        label: "OMP",
        command: ["omp"],
        params: {
          sessionDir: "~/.omp/agent/sessions",
        },
      },
    },
  });

  const runtime = await openBoundarySession(registry.omp, "/tmp/registry-override");
  expect(registry.omp.registration.id).toBe("omp");
  expect(omp.recordedLaunches[0]?.argv).toEqual([
    "custom-omp",
    "--mode",
    "rpc-ui",
    "--approval-mode",
    "yolo",
  ]);
  await runtime.close();
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

  expect(registry["my-agent"].registration.id).toBe("my-agent");
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
  ]);
});

test("Hub E2E ACP provider negotiates exact grants for its injected MCP server", async () => {
  const registry = buildProviderRegistry(logger, {
    providerOverrides: {
      "hub-e2e": {
        extends: "acp",
        label: "Hub E2E",
        command: ["hub-e2e-agent"],
      },
    },
  });
  const connection = await registry["hub-e2e"].registration.connect({
    versions: [1],
    capabilities: ["permission.tool_policy"],
  });
  expect(connection.capabilities).toEqual(["permission.tool_policy"]);
  await connection.close();
});

test.each([
  { kind: "mcp", server: "hub", tool: "*" },
  { kind: "mcp", server: "other", tool: "finish_execution" },
  { kind: "mcp", server: "hub", tool: "bad/tool" },
])("Hub E2E ACP provider rejects unsupported grant $kind:$server:$tool", async (grant) => {
  const registry = buildProviderRegistry(logger, {
    providerOverrides: {
      "hub-e2e": {
        extends: "acp",
        label: "Hub E2E",
        command: ["hub-e2e-agent"],
      },
    },
  });

  const connection = await registry["hub-e2e"].registration.connect({
    versions: [1],
    capabilities: ["permission.tool_policy"],
  });
  const failures: string[] = [];
  connection.onEvent((event) => {
    if (event.type === "request.failed") failures.push(event.error.message);
  });
  await connection.send({
    type: "session.open",
    requestId: "invalid-policy",
    sessionId: "invalid-policy",
    config: {
      cwd: "/tmp/hub-e2e",
      env: {},
      mcpServers: { hub: { type: "http", url: "http://127.0.0.1/execution" } },
      settings: {},
      toolPolicy: { preapproved: [grant] } as unknown as ToolPolicy,
      persist: false,
    },
    history: "skip",
  });
  await expect
    .poll(() => failures[0])
    .toMatch(/accepts only exact MCP tool grants for the injected 'hub' server/u);
  await connection.close();
});

test("ordinary custom ACP providers remain fail-closed for exact MCP grants", async () => {
  const registry = buildProviderRegistry(logger, {
    providerOverrides: {
      "my-agent": {
        extends: "acp",
        label: "My Agent",
        command: ["my-agent"],
      },
    },
  });

  const connection = await registry["my-agent"].registration.connect({
    versions: [1],
    capabilities: ["permission.tool_policy"],
  });
  expect(connection.capabilities).toEqual([]);
  await expect(
    connection.send({
      type: "session.open",
      requestId: "unsupported-policy",
      sessionId: "unsupported-policy",
      config: {
        cwd: "/tmp/my-agent",
        env: {},
        mcpServers: {},
        settings: {},
        toolPolicy: {
          preapproved: [{ kind: "mcp", server: "hub", tool: "finish_execution" }],
        },
        persist: false,
      },
      history: "skip",
    }),
  ).rejects.toThrow("permission.tool_policy");
  await connection.close();
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

  expect(registry["no-mcp-acp"].registration.id).toBe("no-mcp-acp");
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

  expect(registry.cursor.registration.id).toBe("cursor");
  expect(mockState.constructorArgs.cursor).toEqual([
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

test("traecli provider extending acp uses TraeACPAgentClient", () => {
  const registry = buildProviderRegistry(logger, {
    providerOverrides: {
      traecli: {
        extends: "acp",
        label: "TRAE CLI",
        command: ["traecli", "acp", "serve"],
      },
    },
  });

  expect(registry.traecli.registration.id).toBe("traecli");
  expect(mockState.constructorArgs.trae).toEqual([
    {
      command: ["traecli", "acp", "serve"],
      env: undefined,
      providerParams: undefined,
    },
  ]);
  expect(mockState.constructorArgs.genericAcp).toEqual([]);
});

test("kimi provider extending acp uses KimiACPAgentClient", () => {
  const registry = buildProviderRegistry(logger, {
    providerOverrides: {
      kimi: {
        extends: "acp",
        label: "Kimi Code CLI",
        command: ["kimi", "acp"],
      },
    },
  });

  expect(registry.kimi.registration.id).toBe("kimi");
  expect(mockState.constructorArgs.kimi).toEqual([
    {
      command: ["kimi", "acp"],
      env: undefined,
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
    defaultModeId: "auto",
    enabled: false,
  });
  expect(registry.claude.modes).toEqual(
    AGENT_PROVIDER_DEFINITIONS.find((definition) => definition.id === "claude")?.modes,
  );
  expect(registry.codex.enabled).toBe(true);
});

test("enabled: false still retains its provider registration", () => {
  const registry = buildProviderRegistry(logger, {
    providerOverrides: {
      claude: {
        enabled: false,
      },
    },
  });

  expect(registry.claude.registration).toBeDefined();
  expect(mockState.constructorArgs.claude.length).toBeGreaterThan(0);
  expect(registry.codex.registration).toBeDefined();
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

  const runtime = new ProviderRuntime(registry.claude.registration);
  await expect(runtime.isAvailable()).resolves.toBe(true);
  await runtime.close();
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

    const { models } = await fetchBoundaryCatalog(registry.codex, {
      scope: "workspace",
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

    const { models } = await fetchBoundaryCatalog(registry.codex, {
      scope: "workspace",
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

    const { models } = await fetchBoundaryCatalog(registry.codex, {
      scope: "workspace",
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

    const { models } = await fetchBoundaryCatalog(registry.codex, {
      scope: "workspace",
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

    const { models } = await fetchBoundaryCatalog(registry.claude, {
      scope: "workspace",
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
        ...CLAUDE_CUSTOM_THINKING_FIELDS,
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

    const { models } = await fetchBoundaryCatalog(registry.claude, {
      scope: "workspace",
      cwd: "/tmp/registry-models",
      force: false,
    });

    expect(models).toEqual([
      {
        provider: "claude",
        id: "shared-model",
        label: "Profile Label",
        ...CLAUDE_CUSTOM_THINKING_FIELDS,
      },
      {
        provider: "claude",
        id: "profile-model",
        label: "Profile Model",
        ...CLAUDE_CUSTOM_THINKING_FIELDS,
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

    const { models } = await fetchBoundaryCatalog(registry.codex, {
      scope: "workspace",
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

    const { models } = await fetchBoundaryCatalog(registry.claude, {
      scope: "workspace",
      cwd: "/tmp/registry-models",
      force: false,
    });

    expect(models).toEqual([
      {
        provider: "claude",
        id: "shared-model",
        label: "Profile Label",
        description: "Runtime description",
        ...CLAUDE_CUSTOM_THINKING_FIELDS,
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

    const { models } = await fetchBoundaryCatalog(registry.claude, {
      scope: "workspace",
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
        ...CLAUDE_CUSTOM_THINKING_FIELDS,
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
    const { models } = await fetchBoundaryCatalog(registry.claude, {
      scope: "workspace",
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

  test("Claude configured models can override or disable inferred thinking options", async () => {
    const registry = buildProviderRegistry(logger, {
      providerOverrides: {
        claude: {
          models: [
            { id: "custom-defaults", label: "Defaults" },
            { id: "claude-sonnet-5", label: "Known" },
            { id: "claude-opus-5", label: "Disabled", thinkingOptions: [] },
            {
              id: "custom-explicit",
              label: "Explicit",
              thinkingOptions: [{ id: "bespoke", label: "Bespoke", isDefault: true }],
            },
          ],
        },
      },
    });

    const { models } = await fetchBoundaryCatalog(registry.claude, {
      scope: "workspace",
      cwd: "/tmp/registry-models",
      force: false,
    });

    expect(models.find((model) => model.id === "custom-defaults")).toMatchObject(
      CLAUDE_CUSTOM_THINKING_FIELDS,
    );
    expect(
      models
        .find((model) => model.id === "claude-sonnet-5")
        ?.thinkingOptions?.map((option) => option.id),
    ).toEqual(["off", "low", "medium", "high", "xhigh", "max", "ultracode"]);
    expect(models.find((model) => model.id === "claude-opus-5")?.thinkingOptions).toEqual([]);
    expect(models.find((model) => model.id === "custom-explicit")).toMatchObject({
      thinkingOptions: [{ id: "bespoke", label: "Bespoke", isDefault: true }],
      defaultThinkingOptionId: "bespoke",
    });
  });

  test("built-in boundary catalog honors profile model replacement (issue #579)", async () => {
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

    const catalog = await fetchBoundaryCatalog(registry.codex, {
      cwd: "/tmp/registry-models",
    });

    expect(catalog.models.map((model) => model.id)).toEqual(["profile-fast"]);
    expect(catalog.models.find((model) => model.isDefault)?.id).toBe("profile-fast");
  });

  test("built-in boundary catalog honors additionalModels default (issue #579)", async () => {
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

    const catalog = await fetchBoundaryCatalog(registry.claude, {
      cwd: "/tmp/registry-models",
    });

    const defaultModel = catalog.models.find((model) => model.isDefault) ?? catalog.models[0];
    expect(defaultModel?.id).toBe("profile-default");
  });

  test("explicit additional models override hidden compatibility entries", async () => {
    mockState.runtimeModels.set("claude", [
      {
        provider: "claude",
        id: "claude-fable-5[1m]",
        label: "Fable 5",
        isSelectable: false,
      },
    ]);
    const registry = buildProviderRegistry(logger, {
      providerOverrides: {
        claude: {
          additionalModels: [{ id: "claude-fable-5[1m]", label: "Gateway Fable 5" }],
        },
      },
    });

    const { models } = await fetchBoundaryCatalog(registry.claude, {
      scope: "workspace",
      cwd: "/tmp/registry-models",
      force: false,
    });

    expect(models).toEqual([
      expect.objectContaining({
        id: "claude-fable-5[1m]",
        label: "Gateway Fable 5",
        isSelectable: true,
        defaultThinkingOptionId: "high",
      }),
    ]);
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

    const { models } = await fetchBoundaryCatalog(registry.claude, {
      scope: "workspace",
      cwd: "/tmp/registry-models",
      force: false,
    });

    expect(models.map((model) => model.id)).toEqual(["MiniMax-M2.7", "MiniMax-M3"]);
    expect(models.find((model) => model.isDefault)?.id).toBe("MiniMax-M3");
  });
});

describe("fetchCatalog", () => {
  test("returns merged models and modes from fetchCatalog", async () => {
    mockState.runtimeModels.set("codex", [
      { provider: "codex", id: "codex-runtime", label: "Codex Runtime" },
    ]);

    const registry = buildProviderRegistry(logger);
    const catalog = await fetchBoundaryCatalog(registry.codex, {
      scope: "workspace",
      cwd: "/tmp/catalog",
      force: false,
    });

    expect(catalog.models.map((model) => model.id)).toEqual(["codex-runtime"]);
    expect(catalog.modes).toEqual([]);
  });

  test("replacement models skip runtime model discovery but preserve additionalModels", async () => {
    mockState.runtimeModels.set("codex", [
      { provider: "codex", id: "codex-runtime", label: "Codex Runtime" },
    ]);

    const registry = buildProviderRegistry(logger, {
      providerOverrides: {
        codex: {
          models: [{ id: "profile-model", label: "Profile Model" }],
          additionalModels: [{ id: "extra-model", label: "Extra Model" }],
        },
      },
    });

    const catalog = await fetchBoundaryCatalog(registry.codex, {
      scope: "workspace",
      cwd: "/tmp/catalog",
      force: false,
    });

    expect(catalog.models.map((model) => model.id)).toEqual(["profile-model", "extra-model"]);
  });

  test("replacement models still resolve the provider's capability-aware default mode", async () => {
    mockState.resolveCodexDefaultModeId.mockResolvedValue("default");
    const registry = buildProviderRegistry(logger, {
      providerOverrides: {
        claude: { models: [{ id: "profile-model", label: "Profile Model" }] },
      },
    });

    const catalog = await fetchBoundaryCatalog(registry.claude, { cwd: "/tmp/catalog" });

    expect(catalog.defaultMode).toBe("default");
    expect(mockState.resolveCodexDefaultModeId).toHaveBeenCalledWith({
      config: { provider: "claude", cwd: "/tmp/catalog" },
    });
  });

  test("additionalModels can override replacement model fields", async () => {
    const registry = buildProviderRegistry(logger, {
      providerOverrides: {
        codex: {
          models: [{ id: "shared-model", label: "Profile Label" }],
          additionalModels: [{ id: "shared-model", label: "Additional Label" }],
        },
      },
    });

    const catalog = await fetchBoundaryCatalog(registry.codex, {
      scope: "workspace",
      cwd: "/tmp/catalog",
      force: false,
    });

    expect(catalog.models).toEqual([
      {
        provider: "codex",
        id: "shared-model",
        label: "Additional Label",
      },
    ]);
  });
});
