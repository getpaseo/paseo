import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type {
  ClientSideConnection,
  InitializeResponse,
  RequestPermissionRequest,
  SessionNotification,
} from "@agentclientprotocol/sdk";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import {
  HermesACPAgentClient,
  getHermesMultiplexManager,
  resetHermesMultiplexManagers,
} from "./hermes-acp-agent.js";
import { ACPMultiplexConnectionManager } from "./acp-multiplex-manager.js";
import { ACPAgentSession, type ACPTransportAcquisition } from "./acp-agent.js";
import { asInternals } from "../../test-utils/class-mocks.js";

const logger = createTestLogger();

describe("HermesACPAgentClient", () => {
  beforeEach(async () => {
    await resetHermesMultiplexManagers();
  });

  test("enables activeTurnSteering: concurrent_prompt by default", () => {
    const client = new HermesACPAgentClient({
      logger,
      command: ["hermes", "acp"],
    });

    expect(client.providerParams.activeTurnSteering).toBe("concurrent_prompt");
  });

  test("preserves explicit activeTurnSteering override", () => {
    const client = new HermesACPAgentClient({
      logger,
      command: ["hermes", "acp"],
      providerParams: {
        activeTurnSteering: "none",
      },
    });

    expect(client.providerParams.activeTurnSteering).toBe("none");
  });

  test("resolves the same multiplex manager for identical command and profile", () => {
    const manager1 = getHermesMultiplexManager(logger, ["hermes", "acp"]);
    const manager2 = getHermesMultiplexManager(logger, ["hermes", "acp"]);

    expect(manager1).toBe(manager2);
  });

  test("resolves different multiplex managers for different HERMES_PROFILE", () => {
    const defaultManager = getHermesMultiplexManager(logger, ["hermes", "acp"]);
    const customManager = getHermesMultiplexManager(logger, ["hermes", "acp"], {
      HERMES_PROFILE: "custom-worker",
    });

    expect(defaultManager).not.toBe(customManager);
  });

  test("resolves different multiplex managers for distinct launchEnv overrides", () => {
    const managerA = getHermesMultiplexManager(logger, ["hermes", "acp"], {
      HERMES_PROFILE: "profile-a",
      API_KEY: "token-a",
    });
    const managerB = getHermesMultiplexManager(logger, ["hermes", "acp"], {
      HERMES_PROFILE: "profile-b",
      API_KEY: "token-b",
    });

    expect(managerA).not.toBe(managerB);
  });

  test("shares one multiplex manager across multiple HermesACPAgentClient instances", () => {
    const client1 = new HermesACPAgentClient({
      logger,
      command: ["hermes", "acp"],
    });
    const client2 = new HermesACPAgentClient({
      logger,
      command: ["hermes", "acp"],
    });

    expect(client1.multiplexManager).toBe(client2.multiplexManager);
  });
});

describe("ACPMultiplexConnectionManager", () => {
  beforeEach(async () => {
    await resetHermesMultiplexManagers();
    vi.restoreAllMocks();
  });

  function createMockChild(): ChildProcessWithoutNullStreams {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    child.stdin = new EventEmitter() as unknown as ChildProcessWithoutNullStreams["stdin"];
    child.stdout = new EventEmitter() as unknown as ChildProcessWithoutNullStreams["stdout"];
    child.stderr = new EventEmitter() as unknown as ChildProcessWithoutNullStreams["stderr"];
    child.kill = vi.fn(() => true) as unknown as ChildProcessWithoutNullStreams["kill"];
    return child;
  }

  interface ManagerTestInternals {
    child: ChildProcessWithoutNullStreams | null;
    connection: ClientSideConnection | null;
    initializeResponse: InitializeResponse | null;
    activeAcquisitions: number;
    clientDispatcher: {
      sessionUpdate: (params: SessionNotification) => Promise<void>;
      requestPermission: (
        params: RequestPermissionRequest,
      ) => Promise<{ outcome: { outcome: "accepted" | "cancelled" } }>;
    } | null;
  }

  test("exercises production acquire, session registration, and multiplex routing", async () => {
    const manager = new ACPMultiplexConnectionManager({
      logger,
      provider: "hermes",
      defaultCommand: ["hermes", "acp"],
      idleTimeoutMs: 1_000,
    });

    const mockChild = createMockChild();
    const mockConnection = {
      initialize: vi.fn(async () => ({ protocolVersion: 1, agentCapabilities: {} })),
      cancel: vi.fn(),
      unstable_closeSession: vi.fn(),
    } as unknown as ClientSideConnection;
    const mockInitResponse: InitializeResponse = { protocolVersion: 1, agentCapabilities: {} };

    // Wire internal started state to exercise acquisition and routing without spawning OS child
    const managerInternals = asInternals<ManagerTestInternals>(manager);
    managerInternals.child = mockChild;
    managerInternals.connection = mockConnection;
    managerInternals.initializeResponse = mockInitResponse;

    // Acquire transport lease 1
    const lease1 = await manager.acquire();
    expect(lease1.connection).toBe(mockConnection);
    expect(managerInternals.activeAcquisitions).toBe(1);

    // Acquire transport lease 2 (reuses same process & connection)
    const lease2 = await manager.acquire();
    expect(lease2.connection).toBe(mockConnection);
    expect(managerInternals.activeAcquisitions).toBe(2);

    // Register two distinct sessions through production lease interface
    const sessionUpdateA = vi.fn();
    const requestPermissionA = vi.fn(async () => ({ outcome: { outcome: "accepted" as const } }));
    const mockSessionA = {
      id: "session-a",
      sessionUpdate: sessionUpdateA,
      requestPermission: requestPermissionA,
      handleProcessExit: vi.fn(),
    } as unknown as ACPAgentSession;

    const sessionUpdateB = vi.fn();
    const requestPermissionB = vi.fn(async () => ({ outcome: { outcome: "cancelled" as const } }));
    const mockSessionB = {
      id: "session-b",
      sessionUpdate: sessionUpdateB,
      requestPermission: requestPermissionB,
      handleProcessExit: vi.fn(),
    } as unknown as ACPAgentSession;

    lease1.registerSession?.(mockSessionA);
    lease2.registerSession?.(mockSessionB);

    // Verify manager's clientDispatcher dispatches to correct session
    const dispatcher = manager.clientDispatcher ?? managerInternals.clientDispatcher;
    expect(dispatcher).toBeDefined();

    if (dispatcher) {
      const updateNotificationA: SessionNotification = {
        sessionId: "session-a",
        update: { sessionUpdate: "turn_started" } as unknown as SessionNotification["update"],
      };
      await dispatcher.sessionUpdate(updateNotificationA);
      expect(sessionUpdateA).toHaveBeenCalledWith(updateNotificationA);
      expect(sessionUpdateB).not.toHaveBeenCalled();

      const permissionRequestB: RequestPermissionRequest = {
        sessionId: "session-b",
        options: [],
        toolCall: {
          toolCallId: "tc-1",
          title: "Run bash",
          kind: "execute",
        } as unknown as RequestPermissionRequest["toolCall"],
      };
      const permResultB = await dispatcher.requestPermission(permissionRequestB);
      expect(permResultB).toEqual({ outcome: { outcome: "cancelled" } });
      expect(requestPermissionB).toHaveBeenCalledWith(permissionRequestB);
      expect(requestPermissionA).not.toHaveBeenCalled();
    }

    // Release leases and verify reference counting
    await lease1.release?.();
    expect(managerInternals.activeAcquisitions).toBe(1);

    await lease2.release?.();
    expect(managerInternals.activeAcquisitions).toBe(0);

    // Clean up
    await manager.shutdown();
  });

  interface SessionTestInternals {
    sessionId: string | null;
    connection: ClientSideConnection | null;
    child: ChildProcessWithoutNullStreams | null;
    transportAcquisition: ACPTransportAcquisition | null;
    closed: boolean;
  }

  test("invalidates idle sessions and closes connections on shared process exit", async () => {
    const session = new ACPAgentSession(
      { provider: "hermes", cwd: "/tmp" },
      {
        provider: "hermes",
        logger,
        defaultCommand: ["hermes", "acp"],
        defaultModes: [],
        capabilities: {
          supportsStreaming: true,
          supportsSessionPersistence: true,
          supportsDynamicModes: true,
          supportsMcpServers: true,
          supportsReasoningStream: true,
          supportsToolInvocations: true,
        },
      },
    );

    const sessionInternals = asInternals<SessionTestInternals>(session);
    sessionInternals.sessionId = "session-idle-test";
    sessionInternals.connection = {} as ClientSideConnection;
    sessionInternals.child = {} as ChildProcessWithoutNullStreams;
    sessionInternals.transportAcquisition = {} as ACPTransportAcquisition;

    expect(sessionInternals.closed).toBe(false);
    expect(sessionInternals.connection).not.toBeNull();

    // Trigger unexpected child exit while session is idle
    session.handleProcessExit(1, null, "Process killed unexpectedly");

    expect(sessionInternals.closed).toBe(true);
    expect(sessionInternals.connection).toBeNull();
    expect(sessionInternals.child).toBeNull();
    expect(sessionInternals.transportAcquisition).toBeNull();

    // Verify subsequent prompt attempts reject fast without hanging
    await expect(session.startTurn("next turn")).rejects.toThrow("hermes session is closed");
  });
});
