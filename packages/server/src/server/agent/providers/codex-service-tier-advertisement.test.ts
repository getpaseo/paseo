import { describe, expect, test } from "vitest";
import type { AgentSessionConfig } from "../agent-sdk-types.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { CodexAppServerAgentClient, CodexAppServerAgentSession } from "./codex-app-server-agent.js";
import {
  createFakeCodexAppServer,
  type FakeCodexAppServer,
} from "./codex/test-utils/fake-app-server.js";

const FAST = { id: "priority", name: "Fast", description: "Faster processing" };
const ULTRAFAST = { id: "ultrafast", name: "Ultrafast", description: "Lowest latency" };

function harness(
  models: unknown[],
  config: Partial<AgentSessionConfig> = {},
  options: { defaults?: Record<string, unknown>; resumed?: boolean } = {},
) {
  const appServer = createFakeCodexAppServer({
    "model/list": () => ({ data: models }),
    "config/read": () => ({ config: options.defaults ?? {} }),
    "collaborationMode/list": () => ({
      data: [
        { name: "Code", mode: "code" },
        { name: "Plan", mode: "plan" },
      ],
    }),
  });
  const session = new CodexAppServerAgentSession(
    {
      provider: "codex",
      cwd: "/tmp/codex-tier-advertisement-test",
      model: "raw-tier-model",
      thinkingOptionId: "medium",
      ...config,
    },
    options.resumed ? { sessionId: "archived-thread" } : null,
    createTestLogger(),
    async () => appServer.child,
  );
  return { session, appServer };
}

function provider(appServer: FakeCodexAppServer) {
  const client = new CodexAppServerAgentClient(createTestLogger());
  const internals = client as unknown as {
    spawnAppServer: () => Promise<typeof appServer.child>;
    autoReviewEnabledPromise: Promise<boolean>;
  };
  internals.spawnAppServer = async () => appServer.child;
  internals.autoReviewEnabledPromise = Promise.resolve(false);
  return client;
}

describe("Codex raw service tier advertisement", () => {
  test.each(["serviceTiers", "additionalSpeedTiers"])(
    "CSV %s is equivalent to its canonical array",
    async (field) => {
      const scalar = harness([{ id: "raw-tier-model", [field]: " low, fast " }]);
      const array = harness([{ id: "raw-tier-model", [field]: ["low", "fast"] }]);
      try {
        await scalar.session.connect();
        await array.session.connect();
        expect(scalar.session.features).toEqual(array.session.features);
        await scalar.session.setFeature("service_tier", "fast");
      } finally {
        await scalar.session.close();
        await array.session.close();
      }
    },
  );

  test.each(["fast_mode", "plan_mode"])(
    "%s rejects invalid Boolean writes and preserves literal false",
    async (featureId) => {
      const { session } = harness([{ id: "raw-tier-model", serviceTiers: [FAST] }]);
      try {
        await session.connect();
        await session.setFeature(featureId, true);
        for (const value of ["false", "true", 0, 1, [], {}, null, undefined]) {
          await expect(session.setFeature(featureId, value)).rejects.toThrow("boolean");
        }
        expect(session.features).toContainEqual(
          expect.objectContaining(
            featureId === "fast_mode"
              ? { id: "service_tier", value: "priority" }
              : { id: "plan_mode", value: true },
          ),
        );
        await session.setFeature(featureId, false);
        expect(session.features).toContainEqual(
          expect.objectContaining(
            featureId === "fast_mode"
              ? { id: "service_tier", value: "default" }
              : { id: "plan_mode", value: false },
          ),
        );
      } finally {
        await session.close();
      }
    },
  );

  test.each([
    ["id-only objects", { serviceTiers: [{ id: "ultrafast" }] }],
    ["string array", { serviceTiers: ["ultrafast"] }],
    ["scalar string", { serviceTiers: "ultrafast" }],
    ["additional array", { additionalSpeedTiers: ["ultrafast"] }],
    ["additional scalar", { additionalSpeedTiers: "ultrafast" }],
    ["both raw fields", { serviceTiers: [FAST], additionalSpeedTiers: ["ultrafast"] }],
  ])(
    "preserves %s on the session connection and sends its canonical tier",
    async (_shape, fields) => {
      const { session, appServer } = harness([{ id: "raw-tier-model", ...fields }]);
      try {
        await session.connect();
        expect(session.features).toContainEqual(
          expect.objectContaining({
            id: "service_tier",
            type: "select",
            value: "default",
            options: expect.arrayContaining([expect.objectContaining({ id: "ultrafast" })]),
          }),
        );
        await session.setFeature("service_tier", "ultrafast");
        await session.startTurn("hello");
        await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
          serviceTier: "ultrafast",
        });
        appServer.assertNoErrors();
      } finally {
        await session.close();
      }
    },
  );

  test.each([
    ["string array", { serviceTiers: ["ultrafast"] }],
    ["scalar string", { serviceTiers: "ultrafast" }],
    ["id-only objects", { serviceTiers: [{ id: "ultrafast" }] }],
  ])("keeps catalog discovery when raw tiers use %s", async (_shape, fields) => {
    const appServer = createFakeCodexAppServer({
      "model/list": () => ({ data: [{ id: "catalog-model", ...fields }] }),
    });
    const catalog = await provider(appServer).fetchCatalog({ cwd: "/tmp" });
    expect(catalog.models.map((model) => model.id)).toContain("catalog-model");
    appServer.assertNoErrors();
  });

  test("skips malformed tier entries without losing valid advertised IDs", async () => {
    const { session } = harness([
      {
        id: "raw-tier-model",
        serviceTiers: [null, 0, { id: false }, { id: "" }, { id: "ultrafast" }],
      },
    ]);
    try {
      await session.connect();
      expect(session.features).toContainEqual(
        expect.objectContaining({
          id: "service_tier",
          options: [
            { id: "default", label: "Normal", isDefault: true },
            { id: "ultrafast", label: "ultrafast" },
          ],
        }),
      );
      await expect(session.setFeature("service_tier", "false")).rejects.toThrow("not available");
    } finally {
      await session.close();
    }
  });

  test("deduplicates repeated advertised tier IDs and retains the provider label", async () => {
    const { session } = harness([
      {
        id: "raw-tier-model",
        serviceTiers: [ULTRAFAST, ULTRAFAST],
        additionalSpeedTiers: ["ultrafast"],
      },
    ]);
    try {
      await session.connect();
      expect(session.features).toContainEqual(
        expect.objectContaining({
          id: "service_tier",
          options: [
            { id: "default", label: "Normal", isDefault: true },
            { id: "ultrafast", label: "Ultrafast" },
          ],
        }),
      );
    } finally {
      await session.close();
    }
  });

  test("selects an exact model ID before another model's alias", async () => {
    const { session } = harness([
      { id: "other-model", model: "raw-tier-model", serviceTiers: [ULTRAFAST] },
      { id: "raw-tier-model", serviceTiers: [FAST] },
    ]);
    try {
      await session.connect();
      await expect(session.setFeature("service_tier", "ultrafast")).rejects.toThrow(
        "not available",
      );
      await session.setFeature("service_tier", "priority");
      expect(session.features).toContainEqual(
        expect.objectContaining({ id: "service_tier", value: "priority" }),
      );
    } finally {
      await session.close();
    }
  });

  test("does not grant a tier through an ambiguous model alias", async () => {
    const { session } = harness(
      [
        { id: "first-model", model: "shared-alias", serviceTiers: [FAST] },
        { id: "second-model", model: "shared-alias", serviceTiers: [ULTRAFAST] },
      ],
      { model: "shared-alias" },
    );
    try {
      await session.connect();
      expect(session.features.map((feature) => feature.id)).not.toContain("service_tier");
      await expect(session.setFeature("service_tier", "priority")).rejects.toThrow("not available");
    } finally {
      await session.close();
    }
  });

  test("unknown raw extensions cannot manufacture a model alias during normalization", async () => {
    const model = JSON.parse(
      '{"id":"other-model","__proto__":{"model":"raw-tier-model"}}',
    ) as Record<string, unknown>;
    model.serviceTiers = [FAST];
    const { session } = harness([model]);
    try {
      await session.connect();
      expect(session.features.map((feature) => feature.id)).not.toContain("service_tier");
      await expect(session.setFeature("service_tier", "priority")).rejects.toThrow("not available");
    } finally {
      await session.close();
    }
  });

  test("does not enable legacy Fast from a string false command", async () => {
    const { session, appServer } = harness([{ id: "raw-tier-model", serviceTiers: [FAST] }]);
    try {
      await session.connect();
      await expect(session.setFeature("fast_mode", "false")).rejects.toThrow("boolean");
      expect(session.features).toContainEqual(
        expect.objectContaining({ id: "service_tier", value: "default" }),
      );
      await session.startTurn("hello");
      await expect(appServer.waitForTurnStart()).resolves.toMatchObject({ serviceTier: "default" });
    } finally {
      await session.close();
    }
  });

  test("does not restore legacy Fast from a string false preference", async () => {
    const { session } = harness([{ id: "raw-tier-model", serviceTiers: [FAST] }], {
      featureValues: { fast_mode: "false" },
    });
    try {
      await session.connect();
      expect(session.features).toContainEqual(
        expect.objectContaining({ id: "service_tier", value: "default" }),
      );
    } finally {
      await session.close();
    }
  });

  test("rejects a legacy Fast command when two advertised tiers share that label", async () => {
    const { session } = harness([
      { id: "raw-tier-model", serviceTiers: [FAST, { ...FAST, id: "other-fast-tier" }] },
    ]);
    try {
      await session.connect();
      await expect(session.setFeature("fast_mode", true)).rejects.toThrow("not available");
    } finally {
      await session.close();
    }
  });

  test("does not restore legacy Fast through an ambiguous advertised label", async () => {
    const { session } = harness(
      [{ id: "raw-tier-model", serviceTiers: [FAST, { ...FAST, id: "other-fast-tier" }] }],
      { featureValues: { fast_mode: true } },
    );
    try {
      await session.connect();
      expect(session.features).toContainEqual(
        expect.objectContaining({ id: "service_tier", value: "default" }),
      );
    } finally {
      await session.close();
    }
  });

  test("does not restore a malformed explicit tier through a legacy Fast preference", async () => {
    const { session } = harness([{ id: "raw-tier-model", serviceTiers: [FAST] }], {
      featureValues: { service_tier: ["ultrafast"], fast_mode: true },
    });
    try {
      await session.connect();
      expect(session.features).toContainEqual(
        expect.objectContaining({ id: "service_tier", value: "default" }),
      );
    } finally {
      await session.close();
    }
  });

  test("an explicit saved tier ID cannot fall back to a similarly named advertised tier", async () => {
    const { session } = harness([{ id: "raw-tier-model", serviceTiers: [FAST] }], {
      featureValues: { service_tier: "fast" },
    });
    try {
      await session.connect();
      expect(session.features).toContainEqual(
        expect.objectContaining({ id: "service_tier", value: "default" }),
      );
    } finally {
      await session.close();
    }
  });

  test("legacy Fast migration uses its advertised label when another tier owns the old marker ID", async () => {
    const { session } = harness(
      [
        {
          id: "raw-tier-model",
          serviceTiers: [{ id: "fast", name: "Other speed", description: "A distinct tier" }, FAST],
        },
      ],
      { featureValues: { fast_mode: true } },
    );
    try {
      await session.connect();
      expect(session.features).toContainEqual(
        expect.objectContaining({ id: "service_tier", value: "priority" }),
      );
    } finally {
      await session.close();
    }
  });

  test.each([false, true])(
    "resolves the configured default before reconciling a saved tier on resumed=%s",
    async (resumed) => {
      const { session, appServer } = harness(
        [
          { id: "catalog-default", isDefault: true, serviceTiers: [FAST] },
          { id: "configured-default", serviceTiers: [ULTRAFAST] },
        ],
        { model: undefined, featureValues: { service_tier: "ultrafast" } },
        {
          resumed,
          defaults: { model: "configured-default", model_reasoning_effort: "medium" },
        },
      );
      try {
        await session.connect();
        expect(session.features).toContainEqual(
          expect.objectContaining({ id: "service_tier", value: "ultrafast" }),
        );
        await session.startTurn("hello");
        await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
          model: "configured-default",
          serviceTier: "ultrafast",
        });
        appServer.assertNoErrors();
      } finally {
        await session.close();
      }
    },
  );

  test("does not grant the catalog default's tier to an unadvertised configured default", async () => {
    const { session } = harness(
      [{ id: "catalog-default", isDefault: true, serviceTiers: [FAST] }],
      { model: undefined },
      { defaults: { model: "unadvertised-default", model_reasoning_effort: "medium" } },
    );
    try {
      await session.connect();
      expect(session.features.map((feature) => feature.id)).not.toContain("service_tier");
      await expect(session.setFeature("service_tier", "priority")).rejects.toThrow("not available");
    } finally {
      await session.close();
    }
  });

  test("preserves false when restoring a Plan toggle", async () => {
    const { session } = harness([{ id: "raw-tier-model", serviceTiers: [FAST] }], {
      featureValues: { plan_mode: "false" },
    });
    try {
      await session.connect();
      expect(session.features).toContainEqual(
        expect.objectContaining({ id: "plan_mode", type: "toggle", value: false }),
      );
    } finally {
      await session.close();
    }
  });

  test("does not enable a Plan toggle from a string false command", async () => {
    const { session } = harness([{ id: "raw-tier-model", serviceTiers: [FAST] }]);
    try {
      await session.connect();
      await expect(session.setFeature("plan_mode", "false")).rejects.toThrow("boolean");
      expect(session.features).toContainEqual(
        expect.objectContaining({ id: "plan_mode", type: "toggle", value: false }),
      );
    } finally {
      await session.close();
    }
  });
});
