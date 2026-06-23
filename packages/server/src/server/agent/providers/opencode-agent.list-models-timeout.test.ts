import { afterEach, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";
import {
  TestOpenCodeClient,
  TestOpenCodeRuntime,
} from "./opencode/test-utils/test-opencode-runtime.js";

afterEach(() => {
  vi.useRealTimers();
});

test("allows a slow provider.list call to succeed instead of failing after 10 seconds", async () => {
  vi.useFakeTimers();

  const runtime = new TestOpenCodeRuntime();
  const openCodeClient = new TestOpenCodeClient();
  openCodeClient.providerListImplementation = () =>
    new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          data: {
            connected: ["zai"],
            all: [
              {
                id: "zai",
                name: "Z.AI",
                models: {
                  "glm-5.1": {
                    name: "GLM 5.1",
                    limit: { context: 128_000 },
                  },
                },
              },
            ],
          },
        });
      }, 15_000);
    });
  runtime.enqueueClient(openCodeClient);

  const client = new OpenCodeAgentClient(createTestLogger(), undefined, { runtime });
  const modelsPromise = client.fetchCatalog({ cwd: "/tmp/opencode-models", force: false });

  await vi.advanceTimersByTimeAsync(15_000);

  await expect(modelsPromise).resolves.toMatchObject({
    models: [
      {
        provider: "opencode",
        id: "zai/glm-5.1",
        label: "GLM 5.1",
      },
    ],
  });
  expect(openCodeClient.calls.providerList).toHaveLength(1);
});

test("passes explicit refresh force through server acquisition", async () => {
  const runtime = new TestOpenCodeRuntime();
  const openCodeClient = new TestOpenCodeClient();
  openCodeClient.providerListResponse = {
    data: {
      connected: ["openai"],
      all: [{ id: "openai", name: "OpenAI", models: {} }],
    },
  };
  runtime.enqueueClient(openCodeClient);

  const client = new OpenCodeAgentClient(createTestLogger(), undefined, { runtime });

  await client.fetchCatalog({ cwd: "/tmp/opencode-models", force: true });

  expect(runtime.acquisitions).toEqual([{ force: true, releaseCount: 1 }]);
});

test("includes models from api-source providers not in connected", async () => {
  // Providers with source "api" are managed by the OpenCode console/subscription.
  // They don't appear in `connected` but are fully usable.
  const runtime = new TestOpenCodeRuntime();
  const openCodeClient = new TestOpenCodeClient();
  openCodeClient.providerListResponse = {
    data: {
      connected: [],
      all: [
        {
          id: "pi",
          name: "Pi",
          source: "api",
          models: {
            "pi-model-1": {
              name: "Pi Model 1",
              limit: { context: 200_000 },
            },
          },
        },
      ],
    },
  };
  runtime.enqueueClient(openCodeClient);

  const client = new OpenCodeAgentClient(createTestLogger(), undefined, { runtime });
  const { models } = await client.fetchCatalog({ cwd: "/tmp/opencode-models", force: false });

  expect(models).toMatchObject([
    {
      provider: "opencode",
      id: "pi/pi-model-1",
      label: "Pi Model 1",
    },
  ]);
});

test("throws when no providers are accessible (neither connected nor api-source)", async () => {
  const runtime = new TestOpenCodeRuntime();
  const openCodeClient = new TestOpenCodeClient();
  openCodeClient.providerListResponse = {
    data: {
      connected: [],
      all: [
        {
          id: "anthropic",
          name: "Anthropic",
          source: "env",
          models: {
            "claude-opus": { name: "Claude Opus", limit: { context: 1_000_000 } },
          },
        },
      ],
    },
  };
  runtime.enqueueClient(openCodeClient);

  const client = new OpenCodeAgentClient(createTestLogger(), undefined, { runtime });

  await expect(client.fetchCatalog({ cwd: "/tmp/opencode-models", force: false })).rejects.toThrow(
    "OpenCode has no connected providers",
  );
});

test("does not throw when only api-source providers are present with no connected providers", async () => {
  const runtime = new TestOpenCodeRuntime();
  const openCodeClient = new TestOpenCodeClient();
  openCodeClient.providerListResponse = {
    data: {
      connected: [],
      all: [
        {
          id: "pi",
          name: "Pi",
          source: "api",
          models: {
            "pi-model-1": { name: "Pi Model 1", limit: { context: 200_000 } },
          },
        },
      ],
    },
  };
  runtime.enqueueClient(openCodeClient);

  const client = new OpenCodeAgentClient(createTestLogger(), undefined, { runtime });

  await expect(
    client.fetchCatalog({ cwd: "/tmp/opencode-models", force: false }),
  ).resolves.toMatchObject({
    models: [
      {
        provider: "opencode",
        id: "pi/pi-model-1",
        label: "Pi Model 1",
      },
    ],
  });
});
