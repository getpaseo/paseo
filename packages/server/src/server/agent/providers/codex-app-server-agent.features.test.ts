import pino from "pino";
import { describe, expect, test } from "vitest";

import type { AgentSession, AgentSessionConfig } from "../agent-sdk-types.js";
import { __codexAppServerInternals } from "./codex-app-server-agent.js";
import {
  createFakeCodexAppServer,
  type FakeCodexAppServer,
} from "./codex/test-utils/fake-app-server.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";

const CODEX_PROVIDER = "codex";

interface CollaborationModeRecord {
  name: string;
  mode?: string | null;
  model?: string | null;
  reasoning_effort?: string | null;
  developer_instructions?: string | null;
}

const TEST_COLLABORATION_MODES: CollaborationModeRecord[] = [
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

type CodexFeaturesTestSession = AgentSession;

interface CapturedLogEntry {
  level?: number;
  msg?: string;
  [key: string]: unknown;
}

function createCapturedLogger(): { logger: pino.Logger; entries: CapturedLogEntry[] } {
  const entries: CapturedLogEntry[] = [];
  const logger = pino(
    { level: "debug" },
    {
      write(line: string) {
        entries.push(JSON.parse(line) as CapturedLogEntry);
      },
    },
  );
  return { logger, entries };
}

function createConfig(overrides: Partial<AgentSessionConfig> = {}): AgentSessionConfig {
  return {
    provider: CODEX_PROVIDER,
    cwd: "/tmp/codex-fast-mode-test",
    modeId: "auto",
    model: "gpt-5.4",
    ...overrides,
  };
}

function createSessionHarness(
  configOverrides: Partial<AgentSessionConfig> = {},
  options: { logger?: pino.Logger } = {},
): {
  session: CodexFeaturesTestSession;
  appServer: FakeCodexAppServer;
} {
  const config = createConfig(configOverrides);
  const appServer = createFakeCodexAppServer({
    "collaborationMode/list": () => ({ data: TEST_COLLABORATION_MODES }),
  });
  const session = new __codexAppServerInternals.CodexAppServerAgentSession(
    { ...config, provider: CODEX_PROVIDER },
    null,
    options.logger ?? createTestLogger(),
    async () => appServer.child,
  ) as CodexFeaturesTestSession;
  return { session, appServer };
}

async function createConnectedSession(
  configOverrides: Partial<AgentSessionConfig> = {},
  options: { logger?: pino.Logger } = {},
): Promise<{
  session: CodexFeaturesTestSession;
  appServer: FakeCodexAppServer;
}> {
  const harness = createSessionHarness(configOverrides, options);
  await harness.session.connect();
  harness.appServer.assertNoErrors();
  return harness;
}

describe("Codex app-server provider features", () => {
  test("features returns fast and plan toggles when supported", async () => {
    const { session } = await createConnectedSession();

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

  test("features returns only plan toggle when model does not support fast mode", async () => {
    const { session } = await createConnectedSession({ model: "gpt-3.5-turbo" });

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

  test("constructor ignores restored fast mode when model does not support it", async () => {
    const { session, appServer } = await createConnectedSession({
      model: "gpt-3.5-turbo",
      featureValues: { fast_mode: true },
    });

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

    await session.startTurn("hello");
    await expect(appServer.waitForTurnStart()).resolves.not.toMatchObject({
      serviceTier: expect.anything(),
    });
  });

  test("setFeature('fast_mode', true) sets serviceTier to fast", async () => {
    const { session, appServer } = await createConnectedSession();

    await session.setFeature?.("fast_mode", true);
    await session.startTurn("hello");

    await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
      serviceTier: "fast",
    });
  });

  test("setFeature('fast_mode', false) clears serviceTier to null", async () => {
    const { session, appServer } = await createConnectedSession({
      featureValues: { fast_mode: true },
    });

    await session.setFeature?.("fast_mode", false);
    await session.startTurn("hello");

    await expect(appServer.waitForTurnStart()).resolves.not.toMatchObject({
      serviceTier: expect.anything(),
    });
  });

  test("setFeature('fast_mode', true) rejects models that do not support fast mode", async () => {
    const { session } = await createConnectedSession({ model: "gpt-3.5-turbo" });

    await expect(session.setFeature?.("fast_mode", true)).rejects.toThrow(
      "Codex fast mode is not available for model 'gpt-3.5-turbo'",
    );
  });

  test("setFeature invalidates runtime info", async () => {
    const { session } = await createConnectedSession();

    await expect(session.getRuntimeInfo()).resolves.not.toMatchObject({
      extra: { collaborationMode: "Plan" },
    });

    await session.setFeature?.("plan_mode", true);

    await expect(session.getRuntimeInfo()).resolves.toMatchObject({
      extra: { collaborationMode: "Plan" },
    });
  });

  test("setFeature throws for unknown feature ids", async () => {
    const { session } = createSessionHarness();

    await expect(session.setFeature?.("unknown_feature", true)).rejects.toThrow(
      "Unknown Codex feature: unknown_feature",
    );
  });

  test("constructor restores feature flags from config.featureValues", async () => {
    const { session, appServer } = await createConnectedSession({
      featureValues: { fast_mode: true, plan_mode: true },
    });

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

    await session.startTurn("hello");
    await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
      serviceTier: "fast",
      collaborationMode: expect.objectContaining({
        mode: "plan",
      }),
    });
  });

  test("startTurn includes serviceTier when fast mode is enabled", async () => {
    const { session, appServer } = await createConnectedSession();

    await session.setFeature?.("fast_mode", true);
    await session.startTurn("hello");

    await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
      serviceTier: "fast",
    });
  });

  test("startTurn logs a sanitized turn/start summary for fast mode observability", async () => {
    const capture = createCapturedLogger();
    const prompt = "secret prompt text should not be logged";
    const { session } = await createConnectedSession(
      { featureValues: { fast_mode: true } },
      { logger: capture.logger },
    );

    await session.startTurn(prompt);

    const entry = capture.entries.find(
      (candidate) => candidate.msg === "Starting Codex app-server turn",
    );
    expect(entry).toMatchObject({
      level: 30,
      msg: "Starting Codex app-server turn",
      model: "gpt-5.4",
      modeId: "auto",
      serviceTier: "fast",
      cwd: "/tmp/codex-fast-mode-test",
    });
    expect(JSON.stringify(entry)).not.toContain(prompt);
  });

  test("setModel clears fast mode when switching to an unsupported model", async () => {
    const { session, appServer } = await createConnectedSession();

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
    await session.startTurn("hello");

    await expect(appServer.waitForTurnStart()).resolves.not.toMatchObject({
      serviceTier: expect.anything(),
    });
  });

  test("startTurn switches collaboration mode when plan mode is enabled", async () => {
    const { session, appServer } = await createConnectedSession();

    await session.setFeature?.("plan_mode", true);
    await session.startTurn("hello");

    await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
      collaborationMode: expect.objectContaining({
        mode: "plan",
      }),
    });
  });
});
