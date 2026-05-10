import { afterEach, expect, test, vi } from "vitest";

vi.mock("@opencode-ai/sdk/v2/client", () => ({
  createOpencodeClient: vi.fn(),
}));

import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";
import { createTestOpenCodeServerManager } from "./opencode/test-server-manager.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("allows a slow provider.list call to succeed instead of failing after 10 seconds", async () => {
  vi.useFakeTimers();

  async function providerList(): Promise<unknown> {
    return new Promise((resolve) => {
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
  }

  vi.mocked(createOpencodeClient).mockReturnValue({
    provider: {
      list: providerList,
    },
  } as never);

  const serverManager = createTestOpenCodeServerManager();
  const client = new OpenCodeAgentClient(createTestLogger(), undefined, undefined, {
    serverManager,
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
      list: async () => ({
        data: {
          connected: ["openai"],
          all: [{ id: "openai", name: "OpenAI", models: {} }],
        },
      }),
    },
  } as never);
  const serverManager = createTestOpenCodeServerManager();

  const client = new OpenCodeAgentClient(createTestLogger(), undefined, undefined, {
    serverManager,
  });

  await client.listModels({ cwd: "/tmp/opencode-models", force: true });

  expect(serverManager.acquisitions).toEqual([{ force: true, released: true }]);
});
