import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { loadConfig } from "./config.js";

const roots: string[] = [];

async function createPaseoHome(config: unknown): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-config-browser-tools-"));
  roots.push(root);
  const paseoHome = path.join(root, ".paseo");
  await mkdir(paseoHome, { recursive: true });
  await writeFile(path.join(paseoHome, "config.json"), JSON.stringify(config, null, 2));
  return paseoHome;
}

describe("daemon browser tools config", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("defaults browser tools off when config is absent", async () => {
    const home = await createPaseoHome({ version: 1 });

    expect(loadConfig(home, { env: {} }).browserToolsEnabled).toBe(false);
  });

  test("loads browser tools opt-in from persisted daemon config", async () => {
    const home = await createPaseoHome({
      version: 1,
      daemon: { browserTools: { enabled: true } },
    });

    expect(loadConfig(home, { env: {} }).browserToolsEnabled).toBe(true);
  });

  test("leaves the daemon without a browser of its own when no CDP endpoint is set", async () => {
    const home = await createPaseoHome({
      version: 1,
      daemon: { browserTools: { enabled: true } },
    });

    expect(loadConfig(home, { env: {} }).browserToolsCdpEndpoint).toBeUndefined();
  });

  test("loads the CDP endpoint the daemon attaches its own browser host to", async () => {
    const home = await createPaseoHome({
      version: 1,
      daemon: { browserTools: { enabled: true, cdpEndpoint: " http://127.0.0.1:9222 " } },
    });

    expect(loadConfig(home, { env: {} }).browserToolsCdpEndpoint).toBe("http://127.0.0.1:9222");
  });

  test("treats a blank CDP endpoint as unset", async () => {
    const home = await createPaseoHome({
      version: 1,
      daemon: { browserTools: { cdpEndpoint: "   " } },
    });

    expect(loadConfig(home, { env: {} }).browserToolsCdpEndpoint).toBeUndefined();
  });
});
