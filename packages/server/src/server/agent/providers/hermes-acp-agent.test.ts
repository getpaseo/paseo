import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { HermesACPAgentClient } from "./hermes-acp-agent.js";

const tempDirs: string[] = [];

async function createHermesHome(configYaml?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "paseo-hermes-home-"));
  tempDirs.push(dir);
  if (configYaml) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "config.yaml"), configYaml, "utf8");
  }
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("HermesACPAgentClient", () => {
  test("listModels returns the default model declared in HERMES_HOME config.yaml", async () => {
    const hermesHome = await createHermesHome([
      "model:",
      "  provider: openai",
      "  default: gpt-5.4",
    ].join("\n"));
    const client = new HermesACPAgentClient({
      logger: createTestLogger(),
      runtimeSettings: { env: { HERMES_HOME: hermesHome } },
    });

    await expect(client.listModels()).resolves.toEqual([
      {
        provider: "hermes",
        id: "gpt-5.4",
        label: "gpt-5.4 (openai)",
        description: `Default model from ${hermesHome}/config.yaml`,
        isDefault: true,
        metadata: {
          source: "hermes-profile-default",
          hermesHome,
        },
      },
    ]);
  });

  test("listModels returns an empty array when no default model is configured", async () => {
    const hermesHome = await createHermesHome("provider: openai\n");
    const client = new HermesACPAgentClient({
      logger: createTestLogger(),
      runtimeSettings: { env: { HERMES_HOME: hermesHome } },
    });

    await expect(client.listModels()).resolves.toEqual([]);
  });

  test("listModels respects runtime HERMES_HOME overrides", async () => {
    const defaultHome = await createHermesHome([
      "model:",
      "  provider: anthropic",
      "  default: claude-sonnet-4",
    ].join("\n"));
    const overrideHome = await createHermesHome([
      "model:",
      "  provider: openai",
      "  default: gpt-5.4",
    ].join("\n"));

    const client = new HermesACPAgentClient({
      logger: createTestLogger(),
      runtimeSettings: { env: { HERMES_HOME: overrideHome } },
    });

    const models = await client.listModels();
    expect(models).toEqual([
      {
        provider: "hermes",
        id: "gpt-5.4",
        label: "gpt-5.4 (openai)",
        description: `Default model from ${overrideHome}/config.yaml`,
        isDefault: true,
        metadata: {
          source: "hermes-profile-default",
          hermesHome: overrideHome,
        },
      },
    ]);
    expect(models[0]?.description).not.toContain(defaultHome);
  });

  test("listModes returns no static modes", async () => {
    const client = new HermesACPAgentClient({ logger: createTestLogger() });

    await expect(client.listModes()).resolves.toEqual([]);
  });
});
