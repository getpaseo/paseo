import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import pino from "pino";
import { afterEach, describe, expect, test } from "vitest";

import { OmpAgentClient } from "../agent/providers/omp/agent.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const TIMEOUT_MS = 90_000;
const FINISH_TIMEOUT_MS = 45_000;
const roots: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

// OMP exits at startup when no model is usable at all, so the home offers one
// offline model and the agent targets Anthropic, which has no credentials here.
function writeOfflineModelsFile(home: string): void {
  const agentDir = path.join(home, ".omp", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    path.join(agentDir, "models.yml"),
    [
      "providers:",
      "  offline:",
      "    baseUrl: http://127.0.0.1:9/v1",
      "    api: openai-completions",
      "    auth: none",
      "    models:",
      "      - id: offline-1",
      "        name: Offline",
      "        api: openai-completions",
      "        reasoning: false",
      "        input: [text]",
      "        contextWindow: 128000",
      "        maxTokens: 4096",
      "        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}",
      "",
    ].join("\n"),
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("daemon E2E (real OMP without credentials)", () => {
  test(
    "a prompt OMP rejects before its agent runs fails the turn with OMP's error",
    async () => {
      const logger = pino({ level: process.env.OMP_E2E_LOG_LEVEL ?? "silent" });
      const ompHome = tempDir("paseo-real-omp-no-auth-");
      writeOfflineModelsFile(ompHome);
      const cwd = tempDir("paseo-real-omp-no-auth-cwd-");
      const daemon = await createTestPaseoDaemon({
        agentClients: {
          omp: new OmpAgentClient({
            logger,
            runtimeSettings: {
              env: {
                HOME: ompHome,
                ANTHROPIC_API_KEY: "",
                ANTHROPIC_OAUTH_TOKEN: "",
              },
            },
          }),
        },
        providerOverrides: { omp: { enabled: true } },
        logger,
        paseoHomeRoot: tempDir("paseo-real-omp-no-auth-home-"),
        staticDir: tempDir("paseo-real-omp-no-auth-static-"),
        cleanup: false,
      });
      const client = new DaemonClient({
        url: `ws://127.0.0.1:${daemon.port}/ws`,
        appVersion: "0.1.45",
      });
      try {
        await client.connect();
        await client.fetchAgents({ subscribe: {} });
        const agent = await client.createAgent({
          cwd,
          title: "no-auth",
          provider: "omp",
          model: "anthropic/claude-haiku-4-5",
          modeId: "full",
        });

        await client.sendMessage(agent.id, "Reply with ok.");
        const finish = await client.waitForFinish(agent.id, FINISH_TIMEOUT_MS);

        expect(finish.status).toBe("error");
        expect(finish.error).toContain("No API key found for anthropic");
      } finally {
        await client.close().catch(() => undefined);
        await daemon.close().catch(() => undefined);
      }
    },
    TIMEOUT_MS,
  );
});
