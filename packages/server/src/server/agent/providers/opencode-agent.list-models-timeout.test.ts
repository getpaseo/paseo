import { afterEach, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";
import {
  TestOpenCodeClient,
  TestOpenCodeHarness,
} from "./opencode/test-utils/test-opencode-harness.js";

afterEach(() => {
  vi.useRealTimers();
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolveDeferred!: (value: T) => void;
  let rejectDeferred!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });
  return { promise, resolve: resolveDeferred, reject: rejectDeferred };
}

test("waits for server release before rejecting an aborted catalog request", async () => {
  const providerListStarted = deferred<void>();
  const providerListCleanupStarted = deferred<void>();
  const providerListCleanupAllowed = deferred<void>();
  const releaseStarted = deferred<void>();
  const releaseAllowed = deferred<void>();
  const runtime = new TestOpenCodeHarness();
  const openCodeClient = new TestOpenCodeClient();
  openCodeClient.providerListImplementation = async (_parameters, options) => {
    providerListStarted.resolve();
    const signal = (options as { signal: AbortSignal }).signal;
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    providerListCleanupStarted.resolve();
    await providerListCleanupAllowed.promise;
    signal.throwIfAborted();
    return {};
  };
  runtime.enqueueClient(openCodeClient);
  runtime.acquireCurrent = async () => ({
    server: runtime.server,
    release: async () => {
      releaseStarted.resolve();
      await releaseAllowed.promise;
    },
  });
  const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
    serverManager: runtime,
    createClient: runtime.createClient,
  });
  const controller = new AbortController();
  const abortReason = new Error("catalog superseded");
  const catalog = client.fetchCatalog({
    scope: "workspace",
    cwd: "/tmp/opencode-models",
    force: false,
    signal: controller.signal,
  });

  await providerListStarted.promise;
  controller.abort(abortReason);
  await providerListCleanupStarted.promise;
  const beforeRequestCleanup = await Promise.race([
    releaseStarted.promise.then(() => "released"),
    new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
  ]);
  expect(beforeRequestCleanup).toBe("pending");

  providerListCleanupAllowed.resolve();
  await releaseStarted.promise;
  const beforeCleanup = await Promise.race([
    catalog.then(
      () => "settled",
      () => "settled",
    ),
    new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
  ]);
  expect(beforeCleanup).toBe("pending");

  releaseAllowed.resolve();
  await expect(catalog).rejects.toBe(abortReason);
});

test("aborts and drains a timed-out SDK request before releasing its server", async () => {
  vi.useFakeTimers();
  const requestCleanupAllowed = deferred<void>();
  let requestCleanupStarted = false;
  let releaseStarted = false;
  const runtime = new TestOpenCodeHarness();
  const openCodeClient = new TestOpenCodeClient();
  openCodeClient.providerListResponse = {
    data: { connected: ["openai"], all: [{ id: "openai", name: "OpenAI", models: {} }] },
  };
  openCodeClient.appAgentsImplementation = async (_parameters, options) => {
    const signal = (options as { signal: AbortSignal }).signal;
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    requestCleanupStarted = true;
    await requestCleanupAllowed.promise;
    signal.throwIfAborted();
    return {};
  };
  runtime.enqueueClient(openCodeClient);
  runtime.acquireCurrent = async () => ({
    server: runtime.server,
    release: async () => {
      releaseStarted = true;
    },
  });
  const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
    serverManager: runtime,
    createClient: runtime.createClient,
  });
  const controller = new AbortController();
  const catalog = client.fetchCatalog({
    scope: "workspace",
    cwd: "/tmp/opencode-models",
    force: false,
    signal: controller.signal,
  });
  const catalogFailure = expect(catalog).rejects.toThrow("OpenCode app.agents timed out after 10s");

  await vi.advanceTimersByTimeAsync(10_000);
  const cleanupStartedAtTimeout = requestCleanupStarted;
  const releasedBeforeCleanup = releaseStarted;
  if (!requestCleanupStarted) {
    controller.abort(new Error("test cleanup"));
    await vi.advanceTimersByTimeAsync(0);
  }
  requestCleanupAllowed.resolve();
  await catalogFailure;

  expect(cleanupStartedAtTimeout).toBe(true);
  expect(releasedBeforeCleanup).toBe(false);
  expect(releaseStarted).toBe(true);
});

test("preserves the first metadata failure while draining the other request", async () => {
  const providerListStarted = deferred<void>();
  const providerListResponse = deferred<never>();
  const modesError = new Error("mode discovery failed first");
  const modelsError = new Error("model discovery failed later");
  const runtime = new TestOpenCodeHarness();
  const openCodeClient = new TestOpenCodeClient();
  openCodeClient.providerListImplementation = async () => {
    providerListStarted.resolve();
    return await providerListResponse.promise;
  };
  openCodeClient.appAgentsImplementation = async () => {
    throw modesError;
  };
  runtime.enqueueClient(openCodeClient);
  const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
    serverManager: runtime,
    createClient: runtime.createClient,
  });

  const catalog = client.fetchCatalog({
    scope: "workspace",
    cwd: "/tmp/opencode-models",
    force: false,
  });
  await providerListStarted.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  providerListResponse.reject(modelsError);

  await expect(catalog).rejects.toBe(modesError);
});

test("allows a slow provider.list call to succeed instead of failing after 10 seconds", async () => {
  vi.useFakeTimers();

  const runtime = new TestOpenCodeHarness();
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

  const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
    serverManager: runtime,
    createClient: runtime.createClient,
  });
  const modelsPromise = client.fetchCatalog({
    scope: "workspace",
    cwd: "/tmp/opencode-models",
    force: false,
  });

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
