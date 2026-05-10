import { afterEach, expect, test, vi } from "vitest";

vi.mock("@opencode-ai/sdk/v2/client", () => ({
  createOpencodeClient: vi.fn(),
}));

import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";
import type { OpenCodeServerManagerLike } from "./opencode/server-manager.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function createFakeServerManager(
  acquire = vi.fn().mockResolvedValue({
    server: { port: 1234, url: "http://127.0.0.1:1234" },
    release: vi.fn(),
  }),
): OpenCodeServerManagerLike {
  return {
    ensureRunning: vi.fn().mockResolvedValue({ port: 1234, url: "http://127.0.0.1:1234" }),
    acquire,
  };
}

test("allows a slow provider.list call to succeed instead of failing after 10 seconds", async () => {
  vi.useFakeTimers();

  const providerList = vi.fn(
    () =>
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
      }),
  );

  vi.mocked(createOpencodeClient).mockReturnValue({
    provider: {
      list: providerList,
    },
  } as never);

  const client = new OpenCodeAgentClient(createTestLogger(), undefined, undefined, {
    serverManager: createFakeServerManager(),
  });
  const modelsPromise = client.listModels({ cwd: "/tmp/opencode-models", force: false });

  await vi.advanceTimersByTimeAsync(15_000);

  await expect(modelsPromise).resolves.toMatchObject([
    {
      provider: "opencode",
      id: "zai/glm-5.1",
      label: "GLM 5.1",
    },
  ]);
});

test("passes explicit refresh force through server acquisition", async () => {
  vi.mocked(createOpencodeClient).mockReturnValue({
    provider: {
      list: vi.fn().mockResolvedValue({
        data: {
          connected: ["openai"],
          all: [{ id: "openai", name: "OpenAI", models: {} }],
        },
      }),
    },
  } as never);
  const acquire = vi.fn().mockResolvedValue({
    server: { port: 1234, url: "http://127.0.0.1:1234" },
    release: vi.fn(),
  });

  const client = new OpenCodeAgentClient(createTestLogger(), undefined, undefined, {
    serverManager: createFakeServerManager(acquire),
  });

  await client.listModels({ cwd: "/tmp/opencode-models", force: true });

  expect(acquire).toHaveBeenCalledWith({ force: true });
});
