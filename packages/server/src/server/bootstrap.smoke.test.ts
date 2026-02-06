import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import pino from "pino";
import { describe, expect, test } from "vitest";

import { createPaseoDaemon, type PaseoDaemonConfig } from "./bootstrap.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";

describe("paseo daemon bootstrap", () => {
  test.runIf(Boolean(process.env.OPENAI_API_KEY))("starts and serves health endpoint", async () => {
    const daemonHandle = await createTestPaseoDaemon({
      openai: { apiKey: process.env.OPENAI_API_KEY! },
      speech: {
        dictationSttProvider: "openai",
        voiceSttProvider: "openai",
        voiceTtsProvider: "openai",
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
    const paseoHomeRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-openai-config-"));
    const paseoHome = path.join(paseoHomeRoot, ".paseo");
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    await mkdir(paseoHome, { recursive: true });

    const config: PaseoDaemonConfig = {
      listen: "127.0.0.1:0",
      paseoHome,
      corsAllowedOrigins: [],
      allowedHosts: true,
      mcpEnabled: false,
      staticDir,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(paseoHome, "agents"),
      relayEnabled: false,
      appBaseUrl: "https://app.paseo.sh",
      openai: undefined,
      speech: {
        dictationSttProvider: "openai",
        voiceSttProvider: "openai",
        voiceTtsProvider: "openai",
      },
    };

    try {
      await expect(createPaseoDaemon(config, pino({ level: "silent" }))).rejects.toThrow(
        "Missing OpenAI credentials"
      );
    } finally {
      await rm(paseoHomeRoot, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
    }
  });
});
