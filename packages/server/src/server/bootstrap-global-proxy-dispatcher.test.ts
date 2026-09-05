import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

const installGlobalProxyDispatcher = vi.hoisted(() => vi.fn());

vi.mock("./global-proxy-dispatcher.js", () => ({ installGlobalProxyDispatcher }));

import { createPaseoDaemon, type PaseoDaemonConfig } from "./bootstrap.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";

async function makeMinimalConfig(
  overrides: Partial<PaseoDaemonConfig> = {},
): Promise<{ config: PaseoDaemonConfig; cleanup: () => Promise<void> }> {
  const paseoHomeRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-global-proxy-dispatcher-"));
  const paseoHome = path.join(paseoHomeRoot, ".paseo");
  const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
  await mkdir(paseoHome, { recursive: true });
  const config: PaseoDaemonConfig = {
    listen: "127.0.0.1:0",
    paseoHome,
    corsAllowedOrigins: [],
    hostnames: true,
    mcpEnabled: false,
    staticDir,
    mcpDebug: false,
    agentClients: createTestAgentClients(),
    agentStoragePath: path.join(paseoHome, "agents"),
    relayEnabled: false,
    appBaseUrl: "https://app.paseo.sh",
    openai: undefined,
    speech: undefined,
    ...overrides,
  };
  return {
    config,
    cleanup: async () => {
      await Promise.all([
        rm(paseoHomeRoot, { recursive: true, force: true }),
        rm(staticDir, { recursive: true, force: true }),
      ]);
    },
  };
}

describe("createPaseoDaemon global proxy dispatcher gating", () => {
  afterEach(() => {
    installGlobalProxyDispatcher.mockClear();
  });

  test("installs the global fetch dispatcher by default", async () => {
    const { config, cleanup } = await makeMinimalConfig();
    const daemon = await createPaseoDaemon(config, pino({ level: "silent" }));
    try {
      expect(installGlobalProxyDispatcher).toHaveBeenCalledExactlyOnceWith(undefined);
    } finally {
      await daemon.stop().catch(() => undefined);
      await cleanup();
    }
  });

  test("passes globalProxyDispatcher: false through so the daemon skips the global dispatcher", async () => {
    const { config, cleanup } = await makeMinimalConfig({ globalProxyDispatcher: false });
    const daemon = await createPaseoDaemon(config, pino({ level: "silent" }));
    try {
      expect(installGlobalProxyDispatcher).toHaveBeenCalledExactlyOnceWith(false);
    } finally {
      await daemon.stop().catch(() => undefined);
      await cleanup();
    }
  });
});
