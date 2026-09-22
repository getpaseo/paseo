import { beforeEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import {
  HermesACPAgentClient,
  getHermesMultiplexManager,
  resetHermesMultiplexManagers,
} from "./hermes-acp-agent.js";

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

  test("routes session updates and permissions to registered sessions by sessionId", () => {
    interface MockSession {
      id: string;
      sessionUpdate: (params: unknown) => void;
      requestPermission: (
        params: unknown,
      ) => Promise<{ outcome: { outcome: "accepted" | "cancelled" } }>;
    }

    const mockSessionA: MockSession = {
      id: "session-a",
      sessionUpdate: vi.fn(),
      requestPermission: vi.fn(async () => ({ outcome: { outcome: "accepted" as const } })),
    };

    const mockSessionB: MockSession = {
      id: "session-b",
      sessionUpdate: vi.fn(),
      requestPermission: vi.fn(async () => ({ outcome: { outcome: "cancelled" as const } })),
    };

    const routerSessions = new Map<string, MockSession>();
    routerSessions.set("session-a", mockSessionA);
    routerSessions.set("session-b", mockSessionB);

    const updateParamsA = {
      sessionId: "session-a",
      update: { sessionUpdate: "turn_started" },
    };
    const updateParamsB = {
      sessionId: "session-b",
      update: { sessionUpdate: "turn_started" },
    };

    routerSessions.get(updateParamsA.sessionId)?.sessionUpdate(updateParamsA);
    expect(mockSessionA.sessionUpdate).toHaveBeenCalledWith(updateParamsA);
    expect(mockSessionB.sessionUpdate).not.toHaveBeenCalled();

    routerSessions.get(updateParamsB.sessionId)?.sessionUpdate(updateParamsB);
    expect(mockSessionB.sessionUpdate).toHaveBeenCalledWith(updateParamsB);
  });
});
