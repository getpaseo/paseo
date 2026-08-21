import { beforeEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";

const mockState = vi.hoisted(() => ({
  superConstructorOptions: [] as unknown[],
}));

vi.mock("./acp-agent.js", () => ({
  DEFAULT_ACP_CAPABILITIES: {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: true,
    supportsMcpServers: true,
    supportsReasoningStream: true,
    supportsToolInvocations: true,
    supportsRewindConversation: false,
    supportsRewindFiles: false,
    supportsRewindBoth: false,
  },
  ACPAgentClient: class ACPAgentClient {
    readonly provider: string;

    constructor(options: unknown) {
      this.provider = "acp";
      mockState.superConstructorOptions.push(options);
    }
  },
}));

import { GenericACPAgentClient } from "./generic-acp-agent.js";

describe("GenericACPAgentClient", () => {
  beforeEach(() => {
    mockState.superConstructorOptions = [];
  });

  test("passes the custom command only as defaultCommand", () => {
    const _client = new GenericACPAgentClient({
      logger: createTestLogger(),
      command: ["hermes", "acp"],
      env: {
        HERMES_LOG: "info",
      },
    });
    void _client;

    expect(mockState.superConstructorOptions).toEqual([
      {
        provider: "acp",
        logger: expect.any(Object),
        runtimeSettings: {
          env: {
            HERMES_LOG: "info",
          },
        },
        defaultCommand: ["hermes", "acp"],
        capabilities: {
          supportsStreaming: true,
          supportsSessionPersistence: true,
          supportsDynamicModes: true,
          supportsMcpServers: true,
          supportsReasoningStream: true,
          supportsToolInvocations: true,
          supportsRewindConversation: false,
          supportsRewindFiles: false,
          supportsRewindBoth: false,
        },
      },
    ]);
  });

  test("uses provider params to report MCP support", () => {
    const _client = new GenericACPAgentClient({
      logger: createTestLogger(),
      command: ["no-mcp-acp", "serve"],
      providerParams: {
        supportsMcpServers: false,
      },
    });
    void _client;

    expect(mockState.superConstructorOptions.at(-1)).toMatchObject({
      capabilities: {
        supportsMcpServers: false,
      },
    });
  });

  test("merges wrapper client capability defaults with provider params", () => {
    const _client = new GenericACPAgentClient({
      logger: createTestLogger(),
      command: ["capable-acp", "serve"],
      clientCapabilities: {
        terminal: true,
      },
      providerParams: {
        clientCapabilities: {
          fs: {
            readTextFile: true,
          },
        },
      },
    });
    void _client;

    expect(mockState.superConstructorOptions.at(-1)).toMatchObject({
      clientCapabilities: {
        fs: {
          readTextFile: true,
        },
        terminal: true,
      },
    });
  });

  test("merges configured capabilities into probe capability overrides", () => {
    const _client = new GenericACPAgentClient({
      logger: createTestLogger(),
      command: ["capable-acp", "serve"],
      clientCapabilities: {
        terminal: true,
      },
      probeClientCapabilities: {
        terminal: false,
      },
      providerParams: {
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
        },
      },
    });
    void _client;

    expect(mockState.superConstructorOptions.at(-1)).toMatchObject({
      probeClientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
        terminal: false,
      },
    });
  });
});
