import { describe, expect, test, vi } from "vitest";

import type { AgentSession, AgentSessionConfig } from "../agent-sdk-types.js";
import { __codexAppServerInternals } from "./codex-app-server-agent.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";

const CODEX_PROVIDER = "codex";

function createConfig(overrides: Partial<AgentSessionConfig> = {}): AgentSessionConfig {
  return {
    provider: CODEX_PROVIDER,
    cwd: "/tmp/codex-fast-mode-test",
    modeId: "auto",
    model: "gpt-5.4",
    ...overrides,
  };
}

function createSession(configOverrides: Partial<AgentSessionConfig> = {}) {
  const config = createConfig(configOverrides);
  const session = new __codexAppServerInternals.CodexAppServerAgentSession(
    { ...config, provider: CODEX_PROVIDER },
    null,
    createTestLogger(),
    () => {
      throw new Error("Test session cannot spawn Codex app-server");
    },
  ) as unknown as AgentSession & { [key: string]: unknown };
  session.connected = true;
  session.currentThreadId = "test-thread";
  return session;
}

describe("Codex app-server provider fast mode", () => {
  test("features returns fast_mode toggle when model supports it", async () => {
    const session = createSession();

    expect(session.features).toEqual([
      {
        type: "toggle",
        id: "fast_mode",
        label: "Fast",
        description: "Priority inference at 2x usage",
        icon: "zap",
        value: false,
      },
    ]);

    await session.setFeature?.("fast_mode", true);

    expect(session.features).toEqual([
      {
        type: "toggle",
        id: "fast_mode",
        label: "Fast",
        description: "Priority inference at 2x usage",
        icon: "zap",
        value: true,
      },
    ]);
  });

  test("features returns empty array when model does not support fast mode", () => {
    const session = createSession({ model: "gpt-3.5-turbo" });

    expect(session.features).toEqual([]);
  });

  test("setFeature('fast_mode', true) sets serviceTier to fast", async () => {
    const session = createSession();

    await session.setFeature?.("fast_mode", true);

    expect((session as any).serviceTier).toBe("fast");
  });

  test("setFeature('fast_mode', false) clears serviceTier to null", async () => {
    const session = createSession({
      featureValues: { fast_mode: true },
    });

    await session.setFeature?.("fast_mode", false);

    expect((session as any).serviceTier).toBeNull();
  });

  test("setFeature invalidates cachedRuntimeInfo", async () => {
    const session = createSession();

    await session.getRuntimeInfo();
    expect((session as any).cachedRuntimeInfo).not.toBeNull();

    await session.setFeature?.("fast_mode", true);

    expect((session as any).cachedRuntimeInfo).toBeNull();
  });

  test("setFeature throws for unknown feature ids", async () => {
    const session = createSession();

    await expect(session.setFeature?.("unknown_feature", true)).rejects.toThrow(
      "Unknown Codex feature: unknown_feature",
    );
  });

  test("constructor restores serviceTier from config.featureValues", () => {
    const session = createSession({
      featureValues: { fast_mode: true },
    });

    expect((session as any).serviceTier).toBe("fast");
    expect(session.features).toEqual([
      {
        type: "toggle",
        id: "fast_mode",
        label: "Fast",
        description: "Priority inference at 2x usage",
        icon: "zap",
        value: true,
      },
    ]);
  });

  test("startTurn includes serviceTier when fast mode is enabled", async () => {
    const session = createSession();
    const request = vi.fn().mockResolvedValue(undefined);
    (session as any).client = { request };
    (session as any).connected = true;
    (session as any).currentThreadId = "thread-123";
    (session as any).ensureThreadLoaded = vi.fn().mockResolvedValue(undefined);
    (session as any).ensureThread = vi.fn().mockResolvedValue(undefined);
    (session as any).buildUserInput = vi.fn().mockResolvedValue([{ type: "text", text: "hi" }]);
    (session as any).resolveSlashCommandInvocation = vi.fn().mockResolvedValue(null);

    await session.setFeature?.("fast_mode", true);
    await session.startTurn("hello");

    expect(request).toHaveBeenCalledWith(
      "turn/start",
      expect.objectContaining({
        serviceTier: "fast",
      }),
      expect.any(Number),
    );
  });

  test("setModel clears fast mode when switching to an unsupported model", async () => {
    const session = createSession();
    const request = vi.fn().mockResolvedValue(undefined);
    (session as any).client = { request };
    (session as any).connected = true;
    (session as any).currentThreadId = "thread-123";
    (session as any).ensureThreadLoaded = vi.fn().mockResolvedValue(undefined);
    (session as any).ensureThread = vi.fn().mockResolvedValue(undefined);
    (session as any).buildUserInput = vi.fn().mockResolvedValue([{ type: "text", text: "hi" }]);
    (session as any).resolveSlashCommandInvocation = vi.fn().mockResolvedValue(null);

    await session.setFeature?.("fast_mode", true);
    await session.setModel("gpt-3.5-turbo");

    expect(session.features).toEqual([]);
    expect((session as any).serviceTier).toBeNull();

    await session.startTurn("hello");

    expect(request).toHaveBeenCalledWith(
      "turn/start",
      expect.not.objectContaining({
        serviceTier: expect.anything(),
      }),
      expect.any(Number),
    );
  });
});
