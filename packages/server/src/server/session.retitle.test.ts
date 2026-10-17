import {
  createMessageReceiptsStub,
  createTestCreationService,
} from "./test-utils/session-stubs.js";
import { afterEach, describe, expect, test, vi } from "vitest";

import { Session } from "./session.js";
import type { SessionOptions } from "./session.js";
import { OWNER_PERMISSIONS } from "./authorization/index.js";
import { asInternals, createStub } from "./test-utils/class-mocks.js";
import { createProviderSnapshotManagerStub } from "./test-utils/session-stubs.js";

interface SessionRetitleInternals {
  handleUpdateAgentRequest(
    agentId: string,
    name: string | undefined,
    labels: Record<string, string> | undefined,
    requestId: string,
  ): Promise<void>;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createRetitleSession(options: {
  title?: string | null;
  prompts?: string[];
  generateAgentTitle: () => Promise<string | null>;
  setTitle: (agentId: string, title: string) => Promise<void>;
}) {
  const onMessage = vi.fn();
  const storedRecord = {
    id: "agent-1",
    provider: "codex",
    cwd: "/tmp/project",
    createdAt: "2026-03-24T00:00:00.000Z",
    updatedAt: "2026-03-24T00:00:00.000Z",
    title: options.title ?? null,
    labels: {},
    lastStatus: "idle" as const,
    config: null,
    persistence: null,
    archivedAt: null as string | null,
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
  };
  const logger = {
    child: () => logger,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const setTitle = vi.fn(options.setTitle);
  const generateAgentTitle = vi.fn(options.generateAgentTitle);
  const session = asInternals<SessionRetitleInternals>(
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
        getAgent: () => ({ id: "agent-1", cwd: "/tmp/project" }),
        waitForAgentClose: async () => undefined,
        getTimelineRows: async () =>
          (options.prompts ?? ["Ship the login form"]).map((text) => ({
            item: { type: "user_message", text },
          })),
        setTitle,
      }),
      agentStorage: createStub<SessionOptions["agentStorage"]>({
        list: async () => [],
        get: async () => storedRecord,
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
      workspaceAutoName: createStub<SessionOptions["workspaceAutoName"]>({
        generateAgentTitle,
      }),
      createAgentMcpTransport: async () => {
        throw new Error("not used");
      },
      stt: null,
      tts: null,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      terminalManager: null,
    }),
  );

  return { onMessage, session, setTitle, generateAgentTitle, storedRecord };
}

function retitleResponses(onMessage: ReturnType<typeof vi.fn>) {
  return onMessage.mock.calls
    .map(([message]) => message)
    .filter(
      (
        message,
      ): message is {
        type: "update_agent_response";
        payload: { requestId: string; agentId: string; accepted: boolean; error: string | null };
      } =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "update_agent_response",
    );
}

describe("agent retitle from user prompts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("accepts only after setTitle succeeds", async () => {
    const setTitleStarted = deferred<void>();
    const allowSetTitle = deferred<void>();
    const { onMessage, session, setTitle } = createRetitleSession({
      generateAgentTitle: async () => "Generated title",
      setTitle: async () => {
        setTitleStarted.resolve();
        await allowSetTitle.promise;
      },
    });

    const pending = session.handleUpdateAgentRequest(
      "agent-1",
      undefined,
      {
        "paseo.retitle": "1",
      },
      "req-1",
    );

    await setTitleStarted.promise;
    expect(setTitle).toHaveBeenCalledWith("agent-1", "Generated title");
    expect(retitleResponses(onMessage)).toEqual([]);

    allowSetTitle.resolve();
    await pending;

    expect(retitleResponses(onMessage)).toEqual([
      {
        type: "update_agent_response",
        payload: {
          requestId: "req-1",
          agentId: "agent-1",
          accepted: true,
          error: null,
        },
      },
    ]);
  });

  test("rejects when generation returns no title", async () => {
    const { onMessage, session, setTitle } = createRetitleSession({
      generateAgentTitle: async () => null,
      setTitle: async () => {
        throw new Error("setTitle should not run");
      },
    });

    await session.handleUpdateAgentRequest("agent-1", undefined, { "paseo.retitle": "1" }, "req-1");

    expect(setTitle).not.toHaveBeenCalled();
    expect(retitleResponses(onMessage)).toEqual([
      {
        type: "update_agent_response",
        payload: {
          requestId: "req-1",
          agentId: "agent-1",
          accepted: false,
          error: "failed to generate title",
        },
      },
    ]);
  });

  test("rejects and keeps the newer title if the agent is renamed during generation", async () => {
    const generateStarted = deferred<void>();
    const allowGenerate = deferred<string | null>();
    const { onMessage, session, setTitle, storedRecord } = createRetitleSession({
      title: "Original",
      generateAgentTitle: async () => {
        generateStarted.resolve();
        return allowGenerate.promise;
      },
      setTitle: async () => {
        throw new Error("stale generated title must not be saved");
      },
    });

    const pending = session.handleUpdateAgentRequest(
      "agent-1",
      undefined,
      {
        "paseo.retitle": "1",
      },
      "req-2",
    );

    await generateStarted.promise;
    storedRecord.title = "Manual name";
    allowGenerate.resolve("AI name");
    await pending;

    expect(setTitle).not.toHaveBeenCalled();
    expect(retitleResponses(onMessage)).toEqual([
      {
        type: "update_agent_response",
        payload: {
          requestId: "req-2",
          agentId: "agent-1",
          accepted: false,
          error: "title changed during generation",
        },
      },
    ]);
  });

  test("rejects when setTitle fails", async () => {
    const { onMessage, session } = createRetitleSession({
      generateAgentTitle: async () => "Generated title",
      setTitle: async () => {
        throw new Error("disk full");
      },
    });

    await session.handleUpdateAgentRequest("agent-1", undefined, { "paseo.retitle": "1" }, "req-3");

    expect(retitleResponses(onMessage)).toEqual([
      {
        type: "update_agent_response",
        payload: {
          requestId: "req-3",
          agentId: "agent-1",
          accepted: false,
          error: "disk full",
        },
      },
    ]);
  });
});
