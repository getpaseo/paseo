import pino from "pino";
import { describe, expect, test } from "vitest";

import type { AgentSession, AgentSessionConfig } from "../agent-sdk-types.js";
import { CodexAppServerAgentSession } from "./codex-app-server-agent.js";
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

const TEST_SPEED_MODELS = [
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
].map((id) => ({
  id,
  isDefault: id === "gpt-5.4",
  defaultReasoningEffort: "medium",
  serviceTiers: [{ id: "priority", name: "Fast", description: "Faster processing" }],
}));

function speedFeature(value: string) {
  return {
    type: "select",
    id: "service_tier",
    label: "Speed",
    description: "Choose processing speed. Faster tiers increase usage.",
    tooltip: "Select speed",
    icon: "zap",
    desktopTrigger: "icon",
    value,
    options: [
      { id: "default", label: "Normal", isDefault: true },
      { id: "priority", label: "Fast" },
    ],
  };
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
  options: { logger?: pino.Logger; models?: unknown[] } = {},
): {
  session: CodexFeaturesTestSession;
  appServer: FakeCodexAppServer;
} {
  const config = createConfig(configOverrides);
  const appServer = createFakeCodexAppServer({
    "collaborationMode/list": () => ({ data: TEST_COLLABORATION_MODES }),
    "model/list": () => ({ data: options.models ?? TEST_SPEED_MODELS }),
  });
  const session = new CodexAppServerAgentSession(
    { ...config, provider: CODEX_PROVIDER },
    null,
    options.logger ?? createTestLogger(),
    async () => appServer.child,
  ) as CodexFeaturesTestSession;
  return { session, appServer };
}

async function createConnectedSession(
  configOverrides: Partial<AgentSessionConfig> = {},
  options: { logger?: pino.Logger; models?: unknown[] } = {},
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
  test("GPT-6.1 Sol offers catalog speed tiers and sends Ultrafast", async () => {
    const { session, appServer } = await createConnectedSession(
      { model: "gpt-6.1-sol" },
      {
        models: [
          {
            id: "gpt-6.1-sol",
            serviceTiers: [
              { id: "priority", name: "Fast", description: "Faster processing" },
              { id: "ultrafast", name: "Ultrafast", description: "Lowest latency" },
            ],
          },
        ],
      },
    );
    try {
      expect(session.features).toContainEqual(
        expect.objectContaining({
          id: "service_tier",
          type: "select",
          value: "default",
          options: [
            { id: "default", label: "Normal", isDefault: true },
            { id: "priority", label: "Fast" },
            { id: "ultrafast", label: "Ultrafast" },
          ],
        }),
      );
      await session.setFeature?.("service_tier", "ultrafast");
      await session.startTurn("hello");
      await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
        serviceTier: "ultrafast",
      });
    } finally {
      await session.close();
    }
  });

  test("new models and service tiers work without a Paseo catalog update", async () => {
    const { session, appServer } = await createConnectedSession(
      { model: "future-codex-model" },
      {
        models: [
          {
            id: "future-codex-model",
            serviceTiers: [
              { id: "future-tier", name: "Future speed", description: "A newly advertised tier" },
            ],
          },
        ],
      },
    );
    try {
      expect(session.features).toContainEqual(
        expect.objectContaining({
          id: "service_tier",
          options: [
            { id: "default", label: "Normal", isDefault: true },
            { id: "future-tier", label: "Future speed" },
          ],
        }),
      );
      await session.setFeature?.("service_tier", "future-tier");
      await session.startTurn("hello");
      await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
        model: "future-codex-model",
        serviceTier: "future-tier",
      });
    } finally {
      await session.close();
    }
  });

  test.each(["priority", "ultrafast"])(
    "restores %s and Normal explicitly overrides an existing thread tier",
    async (tier) => {
      const { session, appServer } = await createConnectedSession(
        { model: "future-model", featureValues: { service_tier: tier } },
        {
          models: [
            {
              id: "future-model",
              serviceTiers: [
                { id: "priority", name: "Fast", description: "Fast processing" },
                { id: "ultrafast", name: "Ultrafast", description: "Ultra processing" },
              ],
            },
          ],
        },
      );
      try {
        expect(session.features).toContainEqual(
          expect.objectContaining({ id: "service_tier", value: tier }),
        );
        await session.getRuntimeInfo();
        await session.setFeature?.("service_tier", "default");
        await session.startTurn("hello");
        await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
          serviceTier: "default",
        });
      } finally {
        await session.close();
      }
    },
  );

  test("rejects unadvertised tiers and non-string values", async () => {
    const { session } = await createConnectedSession();
    try {
      for (const value of ["ultrafast", "bogus", true, null]) {
        await expect(session.setFeature?.("service_tier", value)).rejects.toThrow(
          "is not available",
        );
      }
      expect(session.features).toContainEqual(
        expect.objectContaining({ id: "service_tier", value: "default" }),
      );
    } finally {
      await session.close();
    }
  });

  test("switching to a model without the selected tier resets speed", async () => {
    const { session, appServer } = await createConnectedSession(
      { model: "ultra-model", featureValues: { service_tier: "ultrafast" } },
      {
        models: [
          {
            id: "ultra-model",
            serviceTiers: [{ id: "ultrafast", name: "Ultrafast", description: "Ultra processing" }],
          },
          ...TEST_SPEED_MODELS,
        ],
      },
    );
    try {
      await session.setModel("gpt-6.1-sol");
      expect(session.features).toContainEqual(
        expect.objectContaining({ id: "service_tier", value: "default" }),
      );
      await session.startTurn("hello");
      await expect(appServer.waitForTurnStart()).resolves.toMatchObject({ serviceTier: "default" });
    } finally {
      await session.close();
    }
  });

  test("maps legacy Fast commands to the catalog's request id", async () => {
    const { session, appServer } = await createConnectedSession();
    try {
      await session.setFeature?.("fast_mode", true);
      await session.startTurn("hello");
      await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
        serviceTier: "priority",
      });
    } finally {
      await session.close();
    }
  });

  test.each([
    "gpt-6-astra",
    "gpt-6.1-sol",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.6",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.4",
  ])("exposes and sends Fast for %s", async (model) => {
    const { session, appServer } = await createConnectedSession({ model });
    try {
      expect(session.features).toContainEqual(
        expect.objectContaining({
          id: "service_tier",
          value: "default",
        }),
      );
      await session.setFeature?.("service_tier", "priority");
      await session.startTurn("hello");
      await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
        model,
        serviceTier: "priority",
      });
    } finally {
      await session.close();
    }
  });

  test.each([
    "gpt-5.3-codex-spark",
    "gpt-5.3-codex",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5.5-pro",
    "gpt-5",
    "gpt-4.1",
    "o3",
    "o4-mini",
    "gpt-6-unknown",
  ])("does not expose or restore Fast for %s", async (model) => {
    const { session, appServer } = await createConnectedSession({
      model,
      featureValues: { fast_mode: true },
    });
    try {
      expect(session.features.map((feature) => feature.id)).toEqual(["plan_mode"]);
      await expect(session.setFeature?.("fast_mode", true)).rejects.toThrow(
        `Codex fast mode is not available for model '${model}'`,
      );
      await session.startTurn("hello");
      await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
        serviceTier: "default",
      });
    } finally {
      await session.close();
    }
  });

  test("restores Fast on Astra and preserves it when switching supported models", async () => {
    const { session, appServer } = await createConnectedSession({
      model: "gpt-6-astra",
      featureValues: { fast_mode: true },
    });
    try {
      expect(session.features).toContainEqual(
        expect.objectContaining({
          id: "service_tier",
          value: "priority",
        }),
      );
      await session.setModel("gpt-5.6-sol");
      await session.setModel("gpt-6-astra");
      await session.startTurn("hello");
      await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
        model: "gpt-6-astra",
        serviceTier: "priority",
      });
    } finally {
      await session.close();
    }
  });

  test("features returns speed selector and plan toggle when supported", async () => {
    const { session } = await createConnectedSession();

    expect(session.features).toEqual([
      speedFeature("default"),
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

    await session.setFeature?.("service_tier", "priority");
    await session.setFeature?.("plan_mode", true);

    expect(session.features).toEqual([
      speedFeature("priority"),
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
    await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
      serviceTier: "default",
    });
  });

  test("selecting Fast sends the catalog service tier", async () => {
    const { session, appServer } = await createConnectedSession();

    await session.setFeature?.("service_tier", "priority");
    await session.startTurn("hello");

    await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
      serviceTier: "priority",
    });
  });

  test("legacy Fast off explicitly selects Normal", async () => {
    const { session, appServer } = await createConnectedSession({
      featureValues: { fast_mode: true },
    });

    await session.setFeature?.("fast_mode", false);
    await session.startTurn("hello");

    await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
      serviceTier: "default",
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
      speedFeature("priority"),
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
      serviceTier: "priority",
      collaborationMode: expect.objectContaining({
        mode: "plan",
      }),
    });
  });

  test("startTurn includes serviceTier when fast mode is enabled", async () => {
    const { session, appServer } = await createConnectedSession();

    await session.setFeature?.("service_tier", "priority");
    await session.startTurn("hello");

    await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
      serviceTier: "priority",
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
      serviceTier: "priority",
      cwd: "/tmp/codex-fast-mode-test",
    });
    expect(JSON.stringify(entry)).not.toContain(prompt);
  });

  test("setModel clears fast mode when switching to an unsupported model", async () => {
    const { session, appServer } = await createConnectedSession();

    await session.setFeature?.("service_tier", "priority");
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

    await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
      serviceTier: "default",
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
