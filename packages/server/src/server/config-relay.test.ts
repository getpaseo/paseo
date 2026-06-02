import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { loadConfig } from "./config.js";

const roots: string[] = [];

async function createPaseoHome(config: unknown): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-config-relay-"));
  roots.push(root);
  const paseoHome = path.join(root, ".paseo");
  await mkdir(paseoHome, { recursive: true });
  await writeFile(path.join(paseoHome, "config.json"), JSON.stringify(config, null, 2));
  return paseoHome;
}

describe("daemon relay config", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("loads relay TLS from env, persisted config, and hosted relay fallback", async () => {
    const persistedHome = await createPaseoHome({
      version: 1,
      daemon: {
        relay: {
          endpoint: "relay.example.com:443",
          useTls: true,
        },
      },
    });
    expect(loadConfig(persistedHome, { env: {} }).relayUseTls).toBe(true);

    const envHome = await createPaseoHome({
      version: 1,
      daemon: {
        relay: {
          endpoint: "relay.example.com:443",
          useTls: false,
        },
      },
    });
    expect(loadConfig(envHome, { env: { PASEO_RELAY_USE_TLS: "true" } }).relayUseTls).toBe(true);

    const hostedHome = await createPaseoHome({
      version: 1,
      daemon: { relay: {} },
    });
    expect(loadConfig(hostedHome, { env: {} }).relayUseTls).toBe(true);
  });

  test("relayPublicUseTls falls back to relayUseTls when unset", async () => {
    const home = await createPaseoHome({ version: 1, daemon: { relay: {} } });
    // Default: both true (hosted relay)
    expect(loadConfig(home, { env: {} }).relayPublicUseTls).toBe(true);
  });

  test("PASEO_RELAY_PUBLIC_USE_TLS overrides relayUseTls for public side", async () => {
    const home = await createPaseoHome({ version: 1, daemon: { relay: {} } });
    const config = loadConfig(home, {
      env: { PASEO_RELAY_USE_TLS: "false", PASEO_RELAY_PUBLIC_USE_TLS: "true" },
    });
    expect(config.relayUseTls).toBe(false);
    expect(config.relayPublicUseTls).toBe(true);
  });

  test("relayPublicUseTls falls back to relayUseTls when only PASEO_RELAY_USE_TLS is set", async () => {
    const home = await createPaseoHome({ version: 1, daemon: { relay: {} } });
    const config = loadConfig(home, { env: { PASEO_RELAY_USE_TLS: "false" } });
    expect(config.relayUseTls).toBe(false);
    expect(config.relayPublicUseTls).toBe(false);
  });

  test("persisted publicUseTls overrides relayUseTls fallback", async () => {
    const home = await createPaseoHome({
      version: 1,
      daemon: { relay: { useTls: false, publicUseTls: true } },
    });
    const config = loadConfig(home, { env: {} });
    expect(config.relayUseTls).toBe(false);
    expect(config.relayPublicUseTls).toBe(true);
  });
});

describe("daemon service proxy config", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("loads public base URL from env before persisted config", async () => {
    const home = await createPaseoHome({
      version: 1,
      daemon: {
        serviceProxy: {
          publicBaseUrl: "https://persisted.example.com",
        },
      },
    });

    const config = loadConfig(home, {
      env: { PASEO_SERVICE_PROXY_PUBLIC_BASE_URL: "https://env.example.com/" },
    });

    expect(config.serviceProxy).toEqual({
      enabled: true,
      listen: "127.0.0.1:6868",
      publicBaseUrl: "https://env.example.com",
    });
  });

  test("rejects invalid PASEO_SERVICE_PROXY_PUBLIC_BASE_URL values", async () => {
    const home = await createPaseoHome({ version: 1 });

    expect(() =>
      loadConfig(home, {
        env: { PASEO_SERVICE_PROXY_PUBLIC_BASE_URL: "not-a-url" },
      }),
    ).toThrow("Invalid PASEO_SERVICE_PROXY_PUBLIC_BASE_URL: not-a-url");
  });
});

describe("daemon worktree root config", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("resolves relative worktrees.root against PASEO_HOME", async () => {
    const home = await createPaseoHome({
      version: 1,
      worktrees: { root: "custom-worktrees" },
    });

    expect(loadConfig(home, { env: {} }).worktreesRoot).toBe(path.join(home, "custom-worktrees"));
  });

  test("keeps absolute worktrees.root absolute", async () => {
    const home = await createPaseoHome({
      version: 1,
      worktrees: { root: path.join(os.tmpdir(), "paseo-custom-worktrees") },
    });

    expect(loadConfig(home, { env: {} }).worktreesRoot).toBe(
      path.join(os.tmpdir(), "paseo-custom-worktrees"),
    );
  });
});
