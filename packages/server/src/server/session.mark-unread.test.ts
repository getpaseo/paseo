import { describe, expect, test, vi } from "vitest";

import { Session } from "./session.js";
import type { SessionOptions } from "./session.js";
import { OWNER_PERMISSIONS } from "./authorization/index.js";
import { asInternals, createStub } from "./test-utils/class-mocks.js";
import {
  createMessageReceiptsStub,
  createProviderSnapshotManagerStub,
  createTestCreationService,
} from "./test-utils/session-stubs.js";

interface SessionInternals {
  handleUpdateAgentRequest(
    agentId: string,
    name: string | undefined,
    labels: Record<string, string> | undefined,
    requestId: string,
  ): Promise<unknown>;
}

function createSession(agentManager: Record<string, unknown>, onMessage = vi.fn()) {
  const logger = {
    child: () => logger,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const directStorageWrite = vi.fn(async () => {
    throw new Error("Session should not write snapshots directly");
  });
  return {
    onMessage,
    session: asInternals<SessionInternals>(
      new Session({
        messageReceipts: createMessageReceiptsStub(),
        creationService: createTestCreationService(),
        clientId: "test-client",
        permissions: OWNER_PERMISSIONS,
        onMessage,
        logger: createStub<SessionOptions["logger"]>(logger),
        downloadTokenStore: createStub<SessionOptions["downloadTokenStore"]>({}),
        pushNotifications: createStub<SessionOptions["pushNotifications"]>({}),
        paseoHome: "/tmp/paseo-test",
        agentManager: createStub<SessionOptions["agentManager"]>({
          subscribe: () => () => {},
          listAgents: () => [],
          getAgent: () => null,
          ...agentManager,
        }),
        agentStorage: createStub<SessionOptions["agentStorage"]>({
          list: async () => [],
          get: async () => null,
          applySnapshot: directStorageWrite,
          upsert: directStorageWrite,
        }),
        projectRegistry: createStub<SessionOptions["projectRegistry"]>({
          subscribeToMutations: () => () => {},
          initialize: async () => {},
          existsOnDisk: async () => true,
          list: async () => [],
          get: async () => null,
          upsert: async () => {},
          archive: async () => {},
          remove: async () => {},
        }),
        workspaceRegistry: createStub<SessionOptions["workspaceRegistry"]>({
          subscribeToMutations: () => () => {},
          initialize: async () => {},
          existsOnDisk: async () => true,
          list: async () => [],
          get: async () => null,
          upsert: async () => {},
          archive: async () => {},
          remove: async () => {},
        }),
        createAgentMcpTransport: async () => {
          throw new Error("not used");
        },
        stt: null,
        tts: null,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
        terminalManager: null,
      }),
    ),
  };
}

describe("session mark agent unread label", () => {
  test("intercepts paseo.markUnread without writing metadata", async () => {
    const markAgentUnread = vi.fn(async () => undefined);
    const updateAgentMetadata = vi.fn(async () => undefined);
    const { onMessage, session } = createSession({ markAgentUnread, updateAgentMetadata });

    await session.handleUpdateAgentRequest(
      "agent-1",
      undefined,
      { "paseo.markUnread": "1" },
      "req-unread",
    );

    expect(markAgentUnread).toHaveBeenCalledWith("agent-1");
    expect(updateAgentMetadata).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledWith({
      type: "update_agent_response",
      payload: {
        requestId: "req-unread",
        agentId: "agent-1",
        accepted: true,
        error: null,
      },
    });
  });

  test("returns accepted:false when markAgentUnread fails", async () => {
    const markAgentUnread = vi.fn(async () => {
      throw new Error("Agent is no longer finished and read: agent-1");
    });
    const { onMessage, session } = createSession({ markAgentUnread });

    await session.handleUpdateAgentRequest(
      "agent-1",
      undefined,
      { "paseo.markUnread": "1" },
      "req-unread",
    );

    expect(onMessage).toHaveBeenCalledWith({
      type: "update_agent_response",
      payload: {
        requestId: "req-unread",
        agentId: "agent-1",
        accepted: false,
        error: "Agent is no longer finished and read: agent-1",
      },
    });
  });
});
