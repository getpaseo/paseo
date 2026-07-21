import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { MissingAgentCwdError } from "./agent-cwd.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";

describe("ensureAgentLoaded missing cwd", () => {
  test("resumes with allowMissingCwd and hydrates timeline for log recovery", async () => {
    const missingCwd = join(tmpdir(), `paseo-loading-missing-${Date.now()}`);
    const agent: ManagedAgent = Object.create(null);
    Reflect.set(agent, "id", "agent-1");
    Reflect.set(agent, "provider", "codex");
    Reflect.set(agent, "cwd", missingCwd);
    Reflect.set(agent, "lifecycle", "idle");

    const resumeSpy = vi.fn(async () => agent);
    const hydrateSpy = vi.fn(async () => undefined);
    let live: ManagedAgent | null = null;
    const agentManager = {
      getAgent: vi.fn(() => live),
      getRegisteredProviderIds: () => ["codex"],
      resumeAgentFromPersistence: vi.fn(async (...args: unknown[]) => {
        const result = await resumeSpy(...args);
        live = result;
        return result;
      }),
      createAgent: vi.fn(),
      hydrateTimelineFromProvider: hydrateSpy,
      touchAgentActivity: vi.fn(() => live),
      waitForAgentClose: vi.fn(async () => undefined),
    } as unknown as AgentManager;

    const agentStorage = {
      get: vi.fn(async () => ({
        id: "agent-1",
        provider: "codex",
        cwd: missingCwd,
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
        lastActivityAt: "2026-07-01T00:00:00.000Z",
        lastUserMessageAt: null,
        persistence: {
          provider: "codex",
          sessionId: "thread-1",
          metadata: { provider: "codex", cwd: missingCwd },
        },
        labels: {},
      })),
    } as unknown as AgentStorage;

    const loaded = await ensureAgentLoaded("agent-1", {
      agentManager,
      agentStorage,
      logger: createTestLogger(),
      allowMissingCwd: true,
    });

    expect(loaded.id).toBe("agent-1");
    expect(resumeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "thread-1" }),
      expect.objectContaining({ cwd: missingCwd }),
      "agent-1",
      expect.objectContaining({ allowMissingCwd: true }),
    );
    expect(hydrateSpy).toHaveBeenCalledWith("agent-1");
    expect(agentManager.createAgent).not.toHaveBeenCalled();
  });

  test("without allowMissingCwd, resume keeps require-cwd behavior", async () => {
    const missingCwd = join(tmpdir(), `paseo-loading-strict-${Date.now()}`);
    const resumeSpy = vi.fn(async () => {
      throw new Error(`Working directory does not exist: ${missingCwd}`);
    });
    const agentManager = {
      getAgent: vi.fn(() => null),
      getRegisteredProviderIds: () => ["codex"],
      resumeAgentFromPersistence: resumeSpy,
      createAgent: vi.fn(),
      hydrateTimelineFromProvider: vi.fn(),
      touchAgentActivity: vi.fn(() => null),
      waitForAgentClose: vi.fn(async () => undefined),
    } as unknown as AgentManager;

    const agentStorage = {
      get: vi.fn(async () => ({
        id: "agent-2",
        provider: "codex",
        cwd: missingCwd,
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
        lastActivityAt: "2026-07-01T00:00:00.000Z",
        lastUserMessageAt: null,
        persistence: {
          provider: "codex",
          sessionId: "thread-2",
          metadata: { provider: "codex", cwd: missingCwd },
        },
        labels: {},
      })),
    } as unknown as AgentStorage;

    await expect(
      ensureAgentLoaded("agent-2", {
        agentManager,
        agentStorage,
        logger: createTestLogger(),
      }),
    ).rejects.toThrow("Working directory does not exist");

    expect(resumeSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "agent-2",
      expect.objectContaining({ allowMissingCwd: false }),
    );
  });

  test("create-from-storage path throws MissingAgentCwdError when cwd is gone", async () => {
    const missingCwd = join(tmpdir(), `paseo-loading-create-${Date.now()}`);
    const agentManager = {
      getAgent: vi.fn(() => null),
      getRegisteredProviderIds: () => ["codex"],
      resumeAgentFromPersistence: vi.fn(),
      createAgent: vi.fn(),
      hydrateTimelineFromProvider: vi.fn(),
      touchAgentActivity: vi.fn(() => null),
      waitForAgentClose: vi.fn(async () => undefined),
    } as unknown as AgentManager;

    const agentStorage = {
      get: vi.fn(async () => ({
        id: "agent-3",
        provider: "codex",
        cwd: missingCwd,
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
        lastActivityAt: "2026-07-01T00:00:00.000Z",
        lastUserMessageAt: null,
        persistence: null,
        labels: {},
      })),
    } as unknown as AgentStorage;

    await expect(
      ensureAgentLoaded("agent-3", {
        agentManager,
        agentStorage,
        logger: createTestLogger(),
        allowMissingCwd: true,
      }),
    ).rejects.toBeInstanceOf(MissingAgentCwdError);

    expect(agentManager.createAgent).not.toHaveBeenCalled();
  });
});
