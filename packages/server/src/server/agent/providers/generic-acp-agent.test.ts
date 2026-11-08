import { beforeEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";

const mockState = vi.hoisted(() => ({
  superConstructorOptions: [] as unknown[],
}));

vi.mock("./acp-agent.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./acp-agent.js")>();
  return {
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
    isMiniMaxCodeProvider: actual.isMiniMaxCodeProvider,
    MCODE_CLIENT_CAPABILITY_META: actual.MCODE_CLIENT_CAPABILITY_META,
  };
});

import { GenericACPAgentClient } from "./generic-acp-agent.js";

describe("GenericACPAgentClient", () => {
  beforeEach(() => {
    mockState.superConstructorOptions.length = 0;
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
        waitForInitialCommands: true,
      },
    ]);
  });

  test("asks a MiniMax Code provider for its extension notifications", () => {
    const _client = new GenericACPAgentClient({
      logger: createTestLogger(),
      command: ["mcode", "acp"],
      providerId: "minimax-code",
    });
    void _client;

    expect(mockState.superConstructorOptions[0]).toMatchObject({
      clientCapabilityMeta: {
        "minimax-code/extensions": { version: 1, notifications: true },
      },
    });
  });

  test("does not ask another ACP provider for the MiniMax extension notifications", () => {
    const _client = new GenericACPAgentClient({
      logger: createTestLogger(),
      command: ["hermes", "acp"],
      providerId: "other-agent",
    });
    void _client;

    expect(mockState.superConstructorOptions[0]).toMatchObject({
      clientCapabilityMeta: undefined,
    });
  });
});
