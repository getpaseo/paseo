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

  const client = new OpenCodeAgentClient(createTestLogger(), undefined, undefined, { runtime });
  const modelsPromise = client.listModels({ cwd: "/tmp/opencode-models", force: false });

  await vi.advanceTimersByTimeAsync(15_000);

  await expect(modelsPromise).resolves.toMatchObject([
    {
      provider: "opencode",
      id: "zai/glm-5.1",
      label: "GLM 5.1",
    },
  ]);
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

  const client = new OpenCodeAgentClient(createTestLogger(), undefined, undefined, { runtime });

  await client.listModels({ cwd: "/tmp/opencode-models", force: true });

  expect(runtime.acquisitions).toEqual([{ force: true, releaseCount: 1 }]);
});
