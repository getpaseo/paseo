import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, test, vi } from "vitest";

import { AgentManager } from "../agent-manager.js";
import { toAgentPayload } from "../agent-projections.js";
import { AgentStorage } from "../agent-storage.js";
import {
  toWireDaemonConfig,
  type ConvertProfileOptions,
  type MutableDaemonConfig,
} from "../../daemon-config-store.js";
import { convertLegacyOptions } from "../option-controls.js";
import type {
  AgentClient,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../agent-sdk-types.js";
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

function speedControl() {
  return {
    type: "select",
    key: "service_tier",
    label: "Speed",
    description: "Choose processing speed. Faster tiers increase usage.",
    tooltip: "Select speed",
    icon: "zap",
    desktopTrigger: "icon",
    defaultValue: "default",
    choices: [
      { value: "default", label: "Normal" },
      { value: "priority", label: "Fast" },
    ],
  };
}

const PLAN_CONTROL = {
  type: "toggle",
  key: "plan_mode",
  label: "Plan",
  description: "Switch Codex into planning-only collaboration mode",
  tooltip: "Toggle plan mode",
  icon: "list-todo",
};

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

describe("Codex app-server provider controls", () => {
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
      expect(session.controls).toContainEqual(
        expect.objectContaining({
          key: "service_tier",
          type: "select",
          defaultValue: "default",
          choices: [
            { value: "default", label: "Normal" },
            { value: "priority", label: "Fast" },
            { value: "ultrafast", label: "Ultrafast" },
          ],
        }),
      );
      await session.applyOptions?.({ service_tier: "ultrafast" });
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
      expect(session.controls).toContainEqual(
        expect.objectContaining({
          key: "service_tier",
          choices: [
            { value: "default", label: "Normal" },
            { value: "future-tier", label: "Future speed" },
          ],
        }),
      );
      await session.applyOptions?.({ service_tier: "future-tier" });
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
        { model: "future-model", providerOptions: { service_tier: tier } },
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
        await session.getRuntimeInfo();
        await session.applyOptions?.({ service_tier: "default" });
        await session.startTurn("hello");
        await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
          serviceTier: "default",
        });
      } finally {
        await session.close();
      }
    },
  );

  test.each(["priority", "ultrafast"])("restores %s from providerOptions", async (tier) => {
    const { session, appServer } = await createConnectedSession(
      { model: "future-model", providerOptions: { service_tier: tier } },
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
      await session.startTurn("hello");
      await expect(appServer.waitForTurnStart()).resolves.toMatchObject({ serviceTier: tier });
    } finally {
      await session.close();
    }
  });

  test("rejects unadvertised tiers and non-string values", async () => {
    const { session, appServer } = await createConnectedSession();
    try {
      for (const value of ["ultrafast", "bogus"]) {
        await expect(session.applyOptions?.({ service_tier: value })).rejects.toThrow(
          "is not available",
        );
      }
      await expect(session.applyOptions?.({ service_tier: true })).rejects.toThrow();
      await session.startTurn("hello");
      await expect(appServer.waitForTurnStart()).resolves.toMatchObject({ serviceTier: "default" });
    } finally {
      await session.close();
    }
  });

  test("switching to a model without the selected tier resets speed", async () => {
    const { session, appServer } = await createConnectedSession(
      { model: "ultra-model", providerOptions: { service_tier: "ultrafast" } },
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
      expect(session.controls).toContainEqual(
        expect.objectContaining({
          key: "service_tier",
          choices: [
            { value: "default", label: "Normal" },
            { value: "priority", label: "Fast" },
          ],
        }),
      );
      await session.startTurn("hello");
      await expect(appServer.waitForTurnStart()).resolves.toMatchObject({ serviceTier: "default" });
    } finally {
      await session.close();
    }
  });

  test("a Fast chosen as `fast` is kept as the catalog's id, so a model with a different Fast id resets it", async () => {
    const { session, appServer } = await createConnectedSession(
      { model: "model-a" },
      {
        models: [
          {
            id: "model-a",
            isDefault: true,
            serviceTiers: [{ id: "priority", name: "Fast", description: "Faster" }],
          },
          {
            id: "model-b",
            serviceTiers: [{ id: "rapid", name: "Fast", description: "Faster" }],
          },
        ],
      },
    );
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await expect(session.applyOptions?.({ service_tier: "fast" })).resolves.toEqual({
        service_tier: "priority",
      });

      await session.setModel("model-b");

      // The option the session reports and the tier the turn runs are the same speed.
      expect(events.filter((event) => event.type === "options_changed")).toEqual([
        expect.objectContaining({ patch: { service_tier: "default" } }),
      ]);
      await session.startTurn("hello");
      await expect(appServer.waitForTurnStart()).resolves.toMatchObject({ serviceTier: "default" });
    } finally {
      await session.close();
    }
  });

  test("`fast` maps to the catalog's request id", async () => {
    const { session, appServer } = await createConnectedSession();
    try {
      await session.applyOptions?.({ service_tier: "fast" });
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
      expect(session.controls).toContainEqual(
        expect.objectContaining({
          key: "service_tier",
          defaultValue: "default",
        }),
      );
      await session.applyOptions?.({ service_tier: "priority" });
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
      providerOptions: { service_tier: "fast" },
    });
    const fresh = await createConnectedSession({ model });
    try {
      expect(session.controls.map((control) => control.key)).toEqual(["plan_mode"]);
      await expect(fresh.session.applyOptions?.({ service_tier: "fast" })).rejects.toThrow(
        `Codex speed 'fast' is not available for model '${model}'`,
      );
      await session.startTurn("hello");
      await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
        serviceTier: "default",
      });
    } finally {
      await session.close();
      await fresh.session.close();
    }
  });

  test("restores Fast on Astra and preserves it when switching supported models", async () => {
    const { session, appServer } = await createConnectedSession({
      model: "gpt-6-astra",
      providerOptions: { service_tier: "fast" },
    });
    try {
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

  test("controls return the speed selector and plan toggle when supported", async () => {
    const { session, appServer } = await createConnectedSession();

    expect(session.controls).toEqual([speedControl(), PLAN_CONTROL]);

    await session.applyOptions?.({ service_tier: "priority", plan_mode: true });
    await session.startTurn("hello");

    await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
      serviceTier: "priority",
      collaborationMode: expect.objectContaining({ mode: "plan" }),
    });
  });

  test("controls return only the plan toggle when model does not support fast mode", async () => {
    const { session } = await createConnectedSession({ model: "gpt-3.5-turbo" });

    expect(session.controls).toEqual([PLAN_CONTROL]);
  });

  test("constructor ignores restored fast mode when model does not support it", async () => {
    const { session, appServer } = await createConnectedSession({
      model: "gpt-3.5-turbo",
      providerOptions: { service_tier: "fast" },
    });

    expect(session.controls).toEqual([PLAN_CONTROL]);

    await session.startTurn("hello");
    await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
      serviceTier: "default",
    });
  });

  test("selecting Fast sends the catalog service tier", async () => {
    const { session, appServer } = await createConnectedSession();

    await session.applyOptions?.({ service_tier: "priority" });
    await session.startTurn("hello");

    await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
      serviceTier: "priority",
    });
  });

  test("selecting Normal after Fast explicitly selects Normal", async () => {
    const { session, appServer } = await createConnectedSession({
      providerOptions: { service_tier: "fast" },
    });

    await session.applyOptions?.({ service_tier: "default" });
    await session.startTurn("hello");

    await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
      serviceTier: "default",
    });
  });

  test('applyOptions({ service_tier: "fast" }) rejects models that do not support fast mode', async () => {
    const { session } = await createConnectedSession({ model: "gpt-3.5-turbo" });

    await expect(session.applyOptions?.({ service_tier: "fast" })).rejects.toThrow(
      "Codex speed 'fast' is not available for model 'gpt-3.5-turbo'",
    );
  });

  test("applyOptions invalidates runtime info", async () => {
    const { session } = await createConnectedSession();

    await expect(session.getRuntimeInfo()).resolves.not.toMatchObject({
      extra: { collaborationMode: "Plan" },
    });

    await session.applyOptions?.({ plan_mode: true });

    await expect(session.getRuntimeInfo()).resolves.toMatchObject({
      extra: { collaborationMode: "Plan" },
    });
  });

  test("constructor restores composer options from config.providerOptions", async () => {
    const { session, appServer } = await createConnectedSession({
      providerOptions: { service_tier: "fast", plan_mode: true },
    });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    expect(session.controls).toEqual([speedControl(), PLAN_CONTROL]);
    // A saved `fast` opens as the model's Fast tier, which the open patch says.
    expect(session.openOptionsPatch).toEqual({ service_tier: "priority" });
    expect(events.filter((event) => event.type === "options_changed")).toEqual([]);

    await session.startTurn("hello");
    await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
      serviceTier: "priority",
      collaborationMode: expect.objectContaining({
        mode: "plan",
      }),
    });
  });

  test("a patch that sets another option keeps the running sandbox and an explicit speed", async () => {
    const { session, appServer } = await createConnectedSession({
      providerOptions: { sandbox_mode: "read-only", service_tier: "default" },
    });

    await session.applyOptions?.({ plan_mode: true });
    await session.startTurn("hello");

    await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
      serviceTier: "default",
      sandboxPolicy: expect.objectContaining({ type: "readOnly" }),
    });
  });

  test("rejects a live change to the approval policy or sandbox, which the thread fixed when it started", async () => {
    const { session } = await createConnectedSession({
      providerOptions: { sandbox_mode: "workspace-write" },
    });

    await expect(session.applyOptions?.({ sandbox_mode: "read-only" })).rejects.toThrow(
      /sandbox_mode.*cannot change on a running session/,
    );
    // The same value is not a change.
    await expect(session.applyOptions?.({ sandbox_mode: "workspace-write" })).resolves.toEqual({});
  });

  test("startTurn includes serviceTier when fast mode is enabled", async () => {
    const { session, appServer } = await createConnectedSession();

    await session.applyOptions?.({ service_tier: "priority" });
    await session.startTurn("hello");

    await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
      serviceTier: "priority",
    });
  });

  test("opening on a model without the saved tier runs Normal and the open patch says so", async () => {
    const models = [
      { id: "plain", isDefault: true, defaultReasoningEffort: "medium", serviceTiers: [] },
    ];
    const { session, appServer } = await createConnectedSession(
      { model: "plain", providerOptions: { service_tier: "priority" } },
      { models },
    );

    expect(session.openOptionsPatch).toEqual({ service_tier: "default" });

    await session.startTurn("hello");
    await expect(appServer.waitForTurnStart()).resolves.toMatchObject({ serviceTier: "default" });
  });

  test("a saved service_tier: fast runs as the model's Fast tier and the open patch names that tier", async () => {
    const { session, appServer } = await createConnectedSession({
      providerOptions: { service_tier: "fast" },
    });

    expect(session.openOptionsPatch).toEqual({ service_tier: "priority" });

    await session.startTurn("hello");
    await expect(appServer.waitForTurnStart()).resolves.toMatchObject({ serviceTier: "priority" });
  });

  test("a live service_tier: fast is returned as the model's Fast tier", async () => {
    const { session, appServer } = await createConnectedSession();

    await expect(session.applyOptions?.({ service_tier: "fast" })).resolves.toEqual({
      service_tier: "priority",
    });

    await session.startTurn("hello");
    await expect(appServer.waitForTurnStart()).resolves.toMatchObject({ serviceTier: "priority" });
  });

  test("switching to a model without the speed tier says Normal and keeps it so on the way back", async () => {
    const models = [
      ...TEST_SPEED_MODELS,
      { id: "plain", isDefault: false, defaultReasoningEffort: "medium", serviceTiers: [] },
    ];
    const { session, appServer } = await createConnectedSession(
      { model: "gpt-5.4", providerOptions: { service_tier: "priority" } },
      { models },
    );
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.setModel?.("plain");
    await session.setModel?.("gpt-5.4");

    expect(events.filter((event) => event.type === "options_changed")).toEqual([
      { type: "options_changed", provider: "codex", patch: { service_tier: "default" } },
    ]);
    await session.startTurn("hello");
    await expect(appServer.waitForTurnStart()).resolves.toMatchObject({ serviceTier: "default" });
  });

  describe("legacy Fast (fast_mode) saved or requested before service_tier", () => {
    function createLegacyFastHarness(
      rawDefaults: Record<string, unknown> = {},
      providerId = CODEX_PROVIDER,
    ) {
      // The provider registry converts configured defaults before it merges them.
      const configDefaults = convertLegacyOptions({
        provider: CODEX_PROVIDER,
        options: rawDefaults,
      });
      const appServer = createFakeCodexAppServer({
        "collaborationMode/list": () => ({ data: TEST_COLLABORATION_MODES }),
        "model/list": () => ({ data: TEST_SPEED_MODELS }),
      });
      const logger = createTestLogger();
      const openSession = async (
        config: AgentSessionConfig,
        resumeSessionId: string | null,
      ): Promise<AgentSession> => {
        const session = new CodexAppServerAgentSession(
          // The provider registry hands sessions the `config.json` defaults merged into the agent's own options.
          {
            ...config,
            provider: CODEX_PROVIDER,
            providerOptions: { ...configDefaults, ...config.providerOptions },
          },
          resumeSessionId ? { sessionId: resumeSessionId } : null,
          logger,
          async () => appServer.child,
        );
        await session.connect();
        return session;
      };
      const client: AgentClient = {
        provider: providerId,
        capabilities: {
          supportsStreaming: true,
          supportsSessionPersistence: true,
          supportsDynamicModes: false,
          supportsMcpServers: false,
          supportsReasoningStream: false,
          supportsToolInvocations: false,
        },
        isAvailable: async () => true,
        fetchCatalog: async () => ({ models: [], modes: [] }),
        // Stands in for the `config.json` provider defaults the registry wrapper merges in.
        effectiveOptions: (own) => ({ ...configDefaults, ...own }),
        createSession: (config) => openSession(config, null),
        resumeSession: (handle, config) =>
          openSession(
            { ...config, provider: CODEX_PROVIDER } as AgentSessionConfig,
            handle.sessionId,
          ),
      };
      const workdir = mkdtempSync(join(tmpdir(), "codex-legacy-fast-"));
      const storage = new AgentStorage(join(workdir, "agents"), logger);
      const manager = new AgentManager({
        clients: { [providerId]: client },
        // A custom provider that extends Codex runs on the Codex adapter.
        providerDefinitions:
          providerId === CODEX_PROVIDER
            ? {}
            : { [providerId]: { enabled: true, derivedFromProviderId: CODEX_PROVIDER } },
        registry: storage,
        logger,
      });
      const turnStarts = () =>
        appServer
          .requests()
          .filter((message) => message.method === "turn/start")
          .map((message) => message.params);

      async function create(providerOptions?: Record<string, unknown>) {
        const agent = await manager.createAgent(
          {
            provider: providerId,
            cwd: workdir,
            model: "gpt-5.4",
            ...(providerOptions ? { providerOptions } : {}),
          },
          undefined,
          { workspaceId: undefined },
        );
        return agent.id;
      }
      async function resume(providerOptions: Record<string, unknown>) {
        const agent = await manager.resumeAgentFromPersistence({
          provider: providerId,
          sessionId: "thread-1",
          metadata: { cwd: workdir, model: "gpt-5.4", providerOptions },
        });
        return agent.id;
      }
      function shownSpeed(agentId: string) {
        const payload = toAgentPayload(manager.getAgent(agentId)!);
        const control = payload.controls?.find((candidate) => candidate.key === "service_tier");
        const choice =
          control?.type === "select"
            ? control.choices.find((candidate) => candidate.value === payload.options?.service_tier)
            : undefined;
        return {
          options: payload.options,
          own: manager.getAgent(agentId)?.config.providerOptions,
          // What a client reading `options` + `controls` selects, and what the legacy `features` show.
          selected:
            payload.options?.service_tier === undefined && control?.type === "select"
              ? control.defaultValue
              : choice?.value,
          feature: payload.features?.find((feature) => feature.id === "service_tier")?.value,
        };
      }
      async function runTurn(agentId: string, expectedTier: string) {
        const before = turnStarts().length;
        await manager.getAgent(agentId)!.session!.startTurn("hello");
        await vi.waitFor(() => expect(turnStarts()).toHaveLength(before + 1));
        const turn = turnStarts()[before]!;
        expect(turn).toMatchObject({ serviceTier: expectedTier });
        appServer.completeTurn({ threadId: String(turn.threadId) });
        await vi.waitFor(() => expect(manager.getAgent(agentId)?.lifecycle).toBe("idle"));
      }
      return { manager, create, resume, shownSpeed, runTurn };
    }

    const FAST = { selected: "priority", feature: "priority" };

    test("a saved fast_mode opens as the model's Fast tier and is stored as that tier", async () => {
      const { manager, create, shownSpeed, runTurn } = createLegacyFastHarness();
      const agentId = await create({ fast_mode: true });
      await manager.flush();

      expect(shownSpeed(agentId)).toMatchObject({
        options: { service_tier: "priority" },
        own: { service_tier: "priority" },
        ...FAST,
      });
      await runTurn(agentId, "priority");
    });

    test("is shown as Fast after a stored record is resumed", async () => {
      const { manager, resume, shownSpeed, runTurn } = createLegacyFastHarness();
      const agentId = await resume({ fast_mode: true });
      await manager.flush();

      expect(shownSpeed(agentId)).toMatchObject({ own: { service_tier: "priority" }, ...FAST });
      await runTurn(agentId, "priority");
    });

    test("from config.json defaults runs Fast and is shown as Fast", async () => {
      const { create, shownSpeed, runTurn } = createLegacyFastHarness({ fast_mode: true });
      const agentId = await create();

      expect(shownSpeed(agentId)).toMatchObject(FAST);
      await runTurn(agentId, "priority");
    });

    test("a saved fast_mode beats a configured service_tier default", async () => {
      const { manager, resume, shownSpeed, runTurn } = createLegacyFastHarness({
        service_tier: "default",
      });
      const agentId = await resume({ fast_mode: true });
      await manager.flush();

      expect(shownSpeed(agentId)).toMatchObject({ own: { service_tier: "priority" }, ...FAST });
      await runTurn(agentId, "priority");
    });

    test("a provider extending Codex opens a saved fast_mode as Fast", async () => {
      const { manager, resume, shownSpeed, runTurn } = createLegacyFastHarness({}, "my-codex");
      const agentId = await resume({ fast_mode: true });
      await manager.flush();

      expect(shownSpeed(agentId)).toMatchObject({ own: { service_tier: "priority" }, ...FAST });
      await runTurn(agentId, "priority");
    });

    test("a provider extending Codex creates with a requested fast_mode and applies a later one", async () => {
      const { manager, create, shownSpeed, runTurn } = createLegacyFastHarness({}, "my-codex");
      const agentId = await create({ fast_mode: false });
      expect(shownSpeed(agentId)).toMatchObject({ own: { service_tier: "default" } });

      await manager.setAgentOptions(agentId, { fast_mode: true });

      expect(shownSpeed(agentId)).toMatchObject({ own: { service_tier: "priority" }, ...FAST });
      await runTurn(agentId, "priority");
    });

    test("an older client's fast_mode runs Fast at once, and a later service_tier replaces it", async () => {
      const { manager, create, shownSpeed, runTurn } = createLegacyFastHarness();
      const agentId = await create();
      expect(shownSpeed(agentId).selected).toBe("default");

      await manager.setAgentOptions(agentId, { fast_mode: true });
      expect(shownSpeed(agentId)).toMatchObject({ own: { service_tier: "priority" }, ...FAST });
      await runTurn(agentId, "priority");

      await manager.setAgentOptions(agentId, { service_tier: "default" });
      expect(shownSpeed(agentId)).toMatchObject({
        own: { service_tier: "default" },
        selected: "default",
        feature: "default",
      });
      await runTurn(agentId, "default");

      await manager.setAgentOptions(agentId, { service_tier: "priority" });
      expect(shownSpeed(agentId)).toMatchObject({ selected: "priority" });
      await runTurn(agentId, "priority");
    });

    test("a request carrying both speed keys follows service_tier", async () => {
      const { manager, create, shownSpeed, runTurn } = createLegacyFastHarness();
      const agentId = await create({ service_tier: "priority" });

      await manager.setAgentOptions(agentId, { service_tier: "default", fast_mode: true });

      expect(shownSpeed(agentId)).toMatchObject({ own: { service_tier: "default" } });
      await runTurn(agentId, "default");
    });

    test.each([CODEX_PROVIDER, "my-codex"])(
      "draft controls for %s accept a legacy fast_mode",
      async (providerId) => {
        const { manager } = createLegacyFastHarness({}, providerId);

        const draft = await manager.listDraftControls({
          provider: providerId,
          cwd: tmpdir(),
          model: "gpt-5.4",
          providerOptions: { fast_mode: true },
        });

        expect(draft.options).toEqual({ service_tier: "fast" });
        expect(draft.controls).toContainEqual(expect.objectContaining({ key: "service_tier" }));
      },
    );

    test.each(["codex", "my-codex"])(
      "the config API shows a %s profile's legacy fast_mode as service_tier",
      (providerId) => {
        const { manager } = createLegacyFastHarness({}, providerId);
        const stored: MutableDaemonConfig = {
          agentProfiles: [
            { id: "p", name: "P", provider: providerId, options: { fast_mode: true } },
          ],
        } as MutableDaemonConfig;

        const convert: ConvertProfileOptions = (provider, options) =>
          manager.convertLegacyOptions(provider, options);

        const wire = toWireDaemonConfig(stored, convert);

        expect(wire.agentProfiles?.[0]).toMatchObject({
          options: { service_tier: "fast" },
          featureValues: { service_tier: "fast" },
        });
      },
    );

    test.each([
      ["a string", "false"],
      ["a number", 1],
    ])("a legacy fast_mode that is %s is rejected, not read as Fast", async (_name, value) => {
      const { manager, create } = createLegacyFastHarness();
      const agentId = await create({});

      await expect(manager.setAgentOptions(agentId, { fast_mode: value })).rejects.toThrow(
        /fast_mode must be true, false or null/,
      );
    });

    test("an older client turning fast_mode off selects Normal", async () => {
      const { manager, create, shownSpeed, runTurn } = createLegacyFastHarness();
      const agentId = await create({ service_tier: "priority" });

      await manager.setAgentOptions(agentId, { fast_mode: false });

      expect(shownSpeed(agentId)).toMatchObject({ own: { service_tier: "default" } });
      await runTurn(agentId, "default");
    });

    test("removing the speed returns the agent to Normal", async () => {
      const { create, manager, shownSpeed } = createLegacyFastHarness();
      const agentId = await create({ service_tier: "priority" });
      expect(shownSpeed(agentId)).toMatchObject(FAST);

      await manager.setAgentOptions(agentId, { service_tier: null });

      expect(shownSpeed(agentId)).toMatchObject({ own: undefined, selected: "default" });
    });
  });

  test("startTurn logs a sanitized turn/start summary for fast mode observability", async () => {
    const capture = createCapturedLogger();
    const prompt = "secret prompt text should not be logged";
    const { session } = await createConnectedSession(
      { providerOptions: { service_tier: "fast" } },
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

    await session.applyOptions?.({ service_tier: "priority" });
    await session.setModel("gpt-3.5-turbo");

    expect(session.controls).toEqual([PLAN_CONTROL]);
    await session.startTurn("hello");

    await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
      serviceTier: "default",
    });
  });

  test("startTurn switches collaboration mode when plan mode is enabled", async () => {
    const { session, appServer } = await createConnectedSession();

    await session.applyOptions?.({ plan_mode: true });
    await session.startTurn("hello");

    await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
      collaborationMode: expect.objectContaining({
        mode: "plan",
      }),
    });
  });
});
