import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import {
  canRunRealProvider,
  createRealProviderClients,
  getRealProviderConfig,
} from "./real-provider-test-config.js";

const TURN_TIMEOUT_MS = 180_000;

describe("daemon E2E (real claude) - context usage", () => {
  let canRun = false;
  let client: DaemonClient | undefined;
  let daemon: TestPaseoDaemon | undefined;
  const cwds: string[] = [];

  beforeAll(async () => {
    canRun = await canRunRealProvider("claude");
    if (!canRun) {
      return;
    }
    const logger = pino({ level: "silent" });
    daemon = await createTestPaseoDaemon({
      agentClients: createRealProviderClients(["claude"], logger),
      logger,
    });
    client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.1.70",
    });
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
  }, 30_000);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await daemon?.close().catch(() => undefined);
    await Promise.all(cwds.map((cwd) => rm(cwd, { recursive: true, force: true })));
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  test(
    "returns a context usage breakdown after one turn",
    async () => {
      if (!client) {
        throw new Error("Claude context-usage harness was not initialized");
      }
      const cwd = await mkdtemp(path.join(tmpdir(), "paseo-claude-context-usage-"));
      cwds.push(cwd);
      const agent = await client.createAgent({
        cwd,
        title: "claude-context-usage",
        ...getRealProviderConfig("claude"),
      });
      expect(agent.capabilities.supportsContextUsage).toBe(true);

      await client.sendMessage(agent.id, "Reply with exactly: OK");
      const finish = await client.waitForFinish(agent.id, TURN_TIMEOUT_MS);
      expect(finish.status).toBe("idle");

      const result = await client.getAgentContextUsage(agent.id, { timeout: TURN_TIMEOUT_MS });
      expect(result.error).toBeNull();
      const usage = result.usage;
      if (!usage) {
        throw new Error("context usage was null");
      }
      expect(usage.categories.length).toBeGreaterThan(0);
      for (const category of usage.categories) {
        expect(Number.isFinite(category.tokens)).toBe(true);
        expect(category.tokens).toBeGreaterThanOrEqual(0);
      }
      expect(usage.totalTokens).toBeGreaterThan(0);
      expect(usage.maxTokens).toBeGreaterThan(0);
    },
    TURN_TIMEOUT_MS,
  );
});
