import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { loadConfig } from "./config.js";

const roots: string[] = [];

async function createPaseoHome(config: unknown): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-config-auth-"));
  roots.push(root);
  const paseoHome = path.join(root, ".paseo");
  await mkdir(paseoHome, { recursive: true });
  await writeFile(path.join(paseoHome, "config.json"), JSON.stringify(config, null, 2));
  return paseoHome;
}

describe("daemon auth config", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("loads optional auth password from config.json", async () => {
    const paseoHome = await createPaseoHome({
      version: 1,
      daemon: {
        auth: { password: "from-config" },
      },
    });

    const config = loadConfig(paseoHome, { env: {} });

    expect(config.auth?.password).toBe("from-config");
  });

  test("lets PASEO_PASSWORD override config.json auth password", async () => {
    const paseoHome = await createPaseoHome({
      version: 1,
      daemon: {
        auth: { password: "from-config" },
      },
    });

    const config = loadConfig(paseoHome, {
      env: { PASEO_PASSWORD: "from-env" },
    });

    expect(config.auth?.password).toBe("from-env");
  });
});
