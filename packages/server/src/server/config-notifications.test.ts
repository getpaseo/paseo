import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { loadConfig } from "./config.js";

const roots: string[] = [];

async function createPaseoHome(config: unknown): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-config-notifications-"));
  roots.push(root);
  const paseoHome = path.join(root, ".paseo");
  await mkdir(paseoHome, { recursive: true });
  await writeFile(path.join(paseoHome, "config.json"), JSON.stringify(config, null, 2));
  return paseoHome;
}

describe("daemon notification config", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("loads the agent attention hook command from persisted config", async () => {
    const paseoHome = await createPaseoHome({
      version: 1,
      notifications: {
        hooks: {
          agentAttention: {
            enabled: true,
            command: ["node", "/opt/paseo/serverchan-hook.mjs"],
            timeoutMs: 2500,
          },
        },
      },
    });

    const config = loadConfig(paseoHome, { env: {} });

    expect(config.agentAttentionHook).toEqual({
      command: ["node", "/opt/paseo/serverchan-hook.mjs"],
      timeoutMs: 2500,
    });
  });

  test("uses the default agent attention hook timeout", async () => {
    const paseoHome = await createPaseoHome({
      version: 1,
      notifications: {
        hooks: {
          agentAttention: {
            command: ["node", "/opt/paseo/serverchan-hook.mjs"],
          },
        },
      },
    });

    const config = loadConfig(paseoHome, { env: {} });

    expect(config.agentAttentionHook).toEqual({
      command: ["node", "/opt/paseo/serverchan-hook.mjs"],
    });
  });

  test("does not enable the agent attention hook when it is disabled", async () => {
    const paseoHome = await createPaseoHome({
      version: 1,
      notifications: {
        hooks: {
          agentAttention: {
            enabled: false,
            command: ["node", "/opt/paseo/serverchan-hook.mjs"],
          },
        },
      },
    });

    const config = loadConfig(paseoHome, { env: {} });

    expect(config.agentAttentionHook).toBeUndefined();
  });
});
