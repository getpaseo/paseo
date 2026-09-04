import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { loadConfig } from "./config.js";

const roots: string[] = [];

async function createPaseoHome(config: unknown): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-config-provider-usage-"));
  roots.push(root);
  const paseoHome = path.join(root, ".paseo");
  await mkdir(paseoHome, { recursive: true });
  await writeFile(path.join(paseoHome, "config.json"), JSON.stringify(config, null, 2));
  return paseoHome;
}

describe("daemon provider usage config", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("defaults to showing every provider", async () => {
    const home = await createPaseoHome({ version: 1 });

    expect(loadConfig(home, { env: {} }).providerUsageHiddenProviders).toEqual([]);
  });

  test("loads hidden providers from persisted daemon config", async () => {
    const home = await createPaseoHome({
      version: 1,
      daemon: { providerUsage: { hiddenProviders: ["copilot", "minimax"] } },
    });

    expect(loadConfig(home, { env: {} }).providerUsageHiddenProviders).toEqual([
      "copilot",
      "minimax",
    ]);
  });
});
