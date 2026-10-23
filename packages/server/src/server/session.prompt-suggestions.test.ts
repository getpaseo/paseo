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

const ensureAgentLoaded = vi.hoisted(() => vi.fn(async () => ({ id: "agent-1" })));
vi.mock("./agent/agent-loading.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent/agent-loading.js")>()),
  ensureAgentLoaded,
}));

interface SessionInternals {
  handlePromptSuggestionsRequest(msg: {
    type: "agent.prompt_suggestions.request";
    agentId: string;
    requestId: string;
  }): Promise<void>;
}

const REQUEST = {
  type: "agent.prompt_suggestions.request",
  agentId: "agent-1",
  requestId: "req-1",
} as const;

const emptyRegistry = {
  subscribeToMutations: () => () => {},
  initialize: async () => {},
  existsOnDisk: async () => true,
  list: async () => [],
  get: async () => null,
  upsert: async () => {},
  archive: async () => {},
  remove: async () => {},
};

function createSession(
  requestPromptSuggestions: SessionOptions["requestPromptSuggestions"],
  capabilities: Record<string, unknown> = { prompt_suggestions: true },
): { session: SessionInternals; messages: Array<{ type: string; payload: unknown }> } {
  const messages: Array<{ type: string; payload: unknown }> = [];
  const logger = {
    child: () => logger,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const session = asInternals<SessionInternals>(
    new Session({
      messageReceipts: createMessageReceiptsStub(),
      creationService: createTestCreationService(),
      clientId: "test-client",
      permissions: OWNER_PERMISSIONS,
      clientCapabilities: capabilities,
      onMessage: (message) => messages.push(message as { type: string; payload: unknown }),
      logger: createStub<SessionOptions["logger"]>(logger),
      downloadTokenStore: createStub<SessionOptions["downloadTokenStore"]>({}),
      pushNotifications: createStub<SessionOptions["pushNotifications"]>({}),
      paseoHome: "/tmp/paseo-test",
      requestPromptSuggestions,
      agentManager: createStub<SessionOptions["agentManager"]>({
        subscribe: () => () => {},
        listAgents: () => [],
        getAgent: () => null,
      }),
      agentStorage: createStub<SessionOptions["agentStorage"]>({
        list: async () => [],
        get: async () => null,
      }),
      projectRegistry: createStub<SessionOptions["projectRegistry"]>(emptyRegistry),
      workspaceRegistry: createStub<SessionOptions["workspaceRegistry"]>(emptyRegistry),
      createAgentMcpTransport: async () => {
        throw new Error("not used");
      },
      stt: null,
      tts: null,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      terminalManager: null,
    }),
  );

  return { session, messages };
}

function responseOf(messages: Array<{ type: string; payload: unknown }>): unknown {
  return messages.find((message) => message.type === "agent.prompt_suggestions.response")?.payload;
}

describe("prompt suggestion requests", () => {
  // The chat a client opens after a restart has no live agent behind it, which
  // is exactly when it holds no suggestion and has to ask.
  test("resumes the agent before asking for suggestions", async () => {
    ensureAgentLoaded.mockClear();
    const request = vi.fn(() => ({ accepted: true }));
    const { session, messages } = createSession(request);

    await session.handlePromptSuggestionsRequest(REQUEST);

    expect(ensureAgentLoaded).toHaveBeenCalledWith("agent-1", expect.anything());
    expect(request).toHaveBeenCalledWith("agent-1");
    expect(responseOf(messages)).toEqual({
      requestId: "req-1",
      agentId: "agent-1",
      accepted: true,
    });
  });

  test("reports the failure when the agent cannot be resumed", async () => {
    ensureAgentLoaded.mockClear();
    ensureAgentLoaded.mockRejectedValueOnce(new Error("agent record is missing"));
    const request = vi.fn(() => ({ accepted: true }));
    const { session, messages } = createSession(request);

    await session.handlePromptSuggestionsRequest(REQUEST);

    expect(request).not.toHaveBeenCalled();
    expect(responseOf(messages)).toMatchObject({
      accepted: false,
      error: "agent record is missing",
    });
  });

  test("declines a client that never advertised the capability", async () => {
    ensureAgentLoaded.mockClear();
    const request = vi.fn(() => ({ accepted: true }));
    const { session, messages } = createSession(request, {});

    await session.handlePromptSuggestionsRequest(REQUEST);

    expect(ensureAgentLoaded).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(responseOf(messages)).toMatchObject({ accepted: false });
  });
});
