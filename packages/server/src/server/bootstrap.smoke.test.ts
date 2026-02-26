import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import pino from "pino";
import { describe, expect, test } from "vitest";

import { createJunctionDaemon, type JunctionDaemonConfig } from "./bootstrap.js";
import { createTestJunctionDaemon } from "./test-utils/junction-daemon.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";

describe("junction daemon bootstrap", () => {
  test("starts and serves health endpoint", async () => {
    const daemonHandle = await createTestJunctionDaemon({
      openai: { apiKey: "test-openai-api-key" },
      speech: {
        providers: {
          dictationStt: { provider: "openai", explicit: true },
          voiceStt: { provider: "openai", explicit: true },
          voiceTts: { provider: "openai", explicit: true },
        },
      },
    });
    try {
      const response = await fetch(
        `http://127.0.0.1:${daemonHandle.port}/api/health`,
        {
          headers: daemonHandle.agentMcpAuthHeader
            ? { Authorization: daemonHandle.agentMcpAuthHeader }
            : undefined,
        }
      );
      expect(response.ok).toBe(true);
      const payload = await response.json();
      expect(payload.status).toBe("ok");
      expect(typeof payload.timestamp).toBe("string");
    } finally {
      await daemonHandle.close();
    }
  });

  test("fails fast when OpenAI speech provider is configured without credentials", async () => {
    const junctionHomeRoot = await mkdtemp(path.join(os.tmpdir(), "junction-openai-config-"));
    const junctionHome = path.join(junctionHomeRoot, ".junction");
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "junction-static-"));
    await mkdir(junctionHome, { recursive: true });

    const config: JunctionDaemonConfig = {
      listen: "127.0.0.1:0",
      junctionHome,
      corsAllowedOrigins: [],
      allowedHosts: true,
      mcpEnabled: false,
      staticDir,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(junctionHome, "agents"),
      relayEnabled: false,
      appBaseUrl: "https://app.junction.sh",
      openai: undefined,
      speech: {
        providers: {
          dictationStt: { provider: "openai", explicit: true },
          voiceStt: { provider: "openai", explicit: true },
          voiceTts: { provider: "openai", explicit: true },
        },
      },
    };

    try {
      await expect(createJunctionDaemon(config, pino({ level: "silent" }))).rejects.toThrow(
        "Missing OpenAI credentials"
      );
    } finally {
      await rm(junctionHomeRoot, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
    }
  });
});
