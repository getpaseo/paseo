import { describe, expect, test, vi } from "vitest";

import type { AgentSession, AgentSessionConfig } from "../agent-sdk-types.js";
import { __codexAppServerInternals } from "./codex-app-server-agent.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";

const CODEX_PROVIDER = "codex";
const TEST_COLLABORATION_MODES = [
  {
    name: "Code",
    mode: "code",
    developer_instructions: "Built-in code mode",
  },
  {
    name: "Plan",
    mode: "plan",
    developer_instructions: "Built-in plan mode",
  },
];

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
  session.collaborationModes = TEST_COLLABORATION_MODES;
  session.refreshResolvedCollaborationMode();
  return session;
}

describe("Codex app-server provider features", () => {
  test("features returns fast and plan toggles when supported", async () => {
    const session = createSession();

    expect(session.features).toEqual([
      {
        type: "toggle",
        id: "fast_mode",
        label: "Fast",
        description: "Priority inference at 2x usage",
        tooltip: "Toggle fast mode",
        icon: "zap",
        value: false,
      },
      {
        type: "toggle",
        id: "plan_mode",
        label: "Plan",
        description: "Switch Codex into planning-only collaboration mode",
        tooltip: "Toggle plan mode",
        icon: "list-todo",
        value: false,
      },
    ]);

    await session.setFeature?.("fast_mode", true);
    await session.setFeature?.("plan_mode", true);

    expect(session.features).toEqual([
      {
        type: "toggle",
        id: "fast_mode",
        label: "Fast",
        description: "Priority inference at 2x usage",
        tooltip: "Toggle fast mode",
        icon: "zap",
        value: true,
      },
      {
        type: "toggle",
        id: "plan_mode",
        label: "Plan",
        description: "Switch Codex into planning-only collaboration mode",
        tooltip: "Toggle plan mode",
        icon: "list-todo",
        value: true,
      },
    ]);
  });

  test("features returns only plan toggle when model does not support fast mode", () => {
    const session = createSession({ model: "gpt-3.5-turbo" });

    expect(session.features).toEqual([
      {
        type: "toggle",
        id: "plan_mode",
        label: "Plan",
        description: "Switch Codex into planning-only collaboration mode",
        tooltip: "Toggle plan mode",
        icon: "list-todo",
        value: false,
      },
    ]);
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

  test("constructor restores feature flags from config.featureValues", () => {
    const session = createSession({
      featureValues: { fast_mode: true, plan_mode: true },
    });

    expect((session as any).serviceTier).toBe("fast");
    expect((session as any).planModeEnabled).toBe(true);
    expect(session.features).toEqual([
      {
        type: "toggle",
        id: "fast_mode",
        label: "Fast",
        description: "Priority inference at 2x usage",
        tooltip: "Toggle fast mode",
        icon: "zap",
        value: true,
      },
      {
        type: "toggle",
        id: "plan_mode",
        label: "Plan",
        description: "Switch Codex into planning-only collaboration mode",
        tooltip: "Toggle plan mode",
        icon: "list-todo",
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

    expect(session.features).toEqual([
      {
        type: "toggle",
        id: "plan_mode",
        label: "Plan",
        description: "Switch Codex into planning-only collaboration mode",
        tooltip: "Toggle plan mode",
        icon: "list-todo",
        value: false,
      },
    ]);
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

  test("startTurn switches collaboration mode when plan mode is enabled", async () => {
    const session = createSession();
    const request = vi.fn().mockResolvedValue(undefined);
    (session as any).client = { request };
    (session as any).connected = true;
    (session as any).currentThreadId = "thread-123";
    (session as any).ensureThreadLoaded = vi.fn().mockResolvedValue(undefined);
    (session as any).ensureThread = vi.fn().mockResolvedValue(undefined);
    (session as any).buildUserInput = vi.fn().mockResolvedValue([{ type: "text", text: "hi" }]);
    (session as any).resolveSlashCommandInvocation = vi.fn().mockResolvedValue(null);

    await session.setFeature?.("plan_mode", true);
    await session.startTurn("hello");

    expect(request).toHaveBeenCalledWith(
      "turn/start",
      expect.objectContaining({
        collaborationMode: expect.objectContaining({
          mode: "plan",
        }),
      }),
      expect.any(Number),
    );
  });
});
