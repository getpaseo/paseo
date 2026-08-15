import { afterEach, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";
import { runProviderRefreshWithDeadline } from "../provider-refresh-deadline.js";
import {
  TestOpenCodeClient,
  TestOpenCodeHarness,
} from "./opencode/test-utils/test-opencode-harness.js";

afterEach(() => {
  vi.useRealTimers();
});

test("the catalog deadline aborts provider.list and releases the server", async () => {
  vi.useFakeTimers();

  const runtime = new TestOpenCodeHarness();
  const openCodeClient = new TestOpenCodeClient();
  openCodeClient.providerListImplementation = (_parameters, options) =>
    new Promise((_resolve, reject) => {
      const signal = (options as { signal: AbortSignal }).signal;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  runtime.enqueueClient(openCodeClient);

  const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
    serverManager: runtime,
    createClient: runtime.createClient,
  });
  const modelsPromise = runProviderRefreshWithDeadline({
    label: "OpenCode",
    timeoutMs: 100,
    operation: (context) =>
      client.fetchCatalog(
        { scope: "workspace", cwd: "/tmp/opencode-models", force: false },
        context,
      ),
  });
  const rejection = expect(modelsPromise).rejects.toThrow(
    "Timed out refreshing OpenCode after 100ms; pending: provider.list",
  );

  await vi.advanceTimersByTimeAsync(100);

  await rejection;
  expect(openCodeClient.calls.providerList).toHaveLength(1);
  expect(openCodeClient.calls.providerListOptions[0]).toMatchObject({
    signal: expect.objectContaining({ aborted: true }),
  });
  expect(runtime.acquisitions).toEqual([{ kind: "current", releaseCount: 1 }]);
});

test("the catalog deadline aborts app.agents and releases the server", async () => {
  vi.useFakeTimers();

  const runtime = new TestOpenCodeHarness();
  const openCodeClient = new TestOpenCodeClient();
  openCodeClient.providerListResponse = {
    data: {
      connected: ["openai"],
      all: [{ id: "openai", name: "OpenAI", models: {} }],
    },
  };
  openCodeClient.appAgentsImplementation = (_parameters, options) =>
    new Promise((_resolve, reject) => {
      const signal = (options as { signal: AbortSignal }).signal;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  runtime.enqueueClient(openCodeClient);

  const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
    serverManager: runtime,
    createClient: runtime.createClient,
  });
  const catalogPromise = runProviderRefreshWithDeadline({
    label: "OpenCode",
    timeoutMs: 100,
    operation: (context) =>
      client.fetchCatalog(
        { scope: "workspace", cwd: "/tmp/opencode-agents", force: false },
        context,
      ),
  });
  const rejection = expect(catalogPromise).rejects.toThrow(
    "Timed out refreshing OpenCode after 100ms; pending: app.agents",
  );

  await vi.advanceTimersByTimeAsync(100);

  await rejection;
  expect(openCodeClient.calls.appAgents).toHaveLength(1);
  expect(openCodeClient.calls.appAgentsOptions[0]).toMatchObject({
    signal: expect.objectContaining({ aborted: true }),
  });
  expect(runtime.acquisitions).toEqual([{ kind: "current", releaseCount: 1 }]);
});

test("uses a new server for explicit catalog refresh", async () => {
  const runtime = new TestOpenCodeHarness();
  const openCodeClient = new TestOpenCodeClient();
  openCodeClient.providerListResponse = {
    data: {
      connected: ["openai"],
      all: [{ id: "openai", name: "OpenAI", models: {} }],
    },
  };
  runtime.enqueueClient(openCodeClient);

  const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
    serverManager: runtime,
    createClient: runtime.createClient,
  });

  await client.fetchCatalog({ scope: "workspace", cwd: "/tmp/opencode-models", force: true });

  expect(runtime.acquisitions).toEqual([{ kind: "new", releaseCount: 1 }]);
});

test("includes models from api-source providers not in connected", async () => {
  // Providers with source "api" are managed by the OpenCode console/subscription.
  // They don't appear in `connected` but are fully usable.
  const runtime = new TestOpenCodeHarness();
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

  const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
    serverManager: runtime,
    createClient: runtime.createClient,
  });
  const { models } = await client.fetchCatalog({
    scope: "workspace",
    cwd: "/tmp/opencode-models",
    force: false,
  });

  expect(models).toMatchObject([
    {
      provider: "opencode",
      id: "pi/pi-model-1",
      label: "Pi Model 1",
    },
  ]);
});

test("throws when no providers are accessible (neither connected nor api-source)", async () => {
  const runtime = new TestOpenCodeHarness();
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

  const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
    serverManager: runtime,
    createClient: runtime.createClient,
  });

  await expect(
    client.fetchCatalog({ scope: "workspace", cwd: "/tmp/opencode-models", force: false }),
  ).rejects.toThrow("OpenCode has no connected providers");
});

test("does not throw when only api-source providers are present with no connected providers", async () => {
  const runtime = new TestOpenCodeHarness();
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

  const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
    serverManager: runtime,
    createClient: runtime.createClient,
  });

  await expect(
    client.fetchCatalog({ scope: "workspace", cwd: "/tmp/opencode-models", force: false }),
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
