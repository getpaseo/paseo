import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import {
  canRunRealProvider,
  createRealProviderClients,
  getRealProviderConfig,
} from "./real-provider-test-config.js";

describe("daemon E2E (real claude) - restart recovery with background work", () => {
  let canRun = false;
  beforeAll(async () => {
    canRun = await canRunRealProvider("claude");
  });
  beforeEach((context) => {
    if (!canRun) context.skip();
  });

  // Fails on main: shutdown capture only records agents whose lastStatus is "running" (#10202).
  test("an idle Claude agent with a running background command is resumed after restart", async () => {
    const logger = pino({ level: "silent" });
    const cwd = mkdtempSync(path.join(tmpdir(), "restart-bg-work-cwd-"));
    const home = mkdtempSync(path.join(tmpdir(), "restart-bg-work-home-"));
    const start = () =>
      createTestPaseoDaemon({
        agentClients: createRealProviderClients(["claude"], logger),
        logger,
        paseoHomeRoot: home,
        cleanup: false,
        resumeOnStartup: true,
      });
    let daemon = await start();
    let client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    try {
      await client.connect();
      await client.fetchAgents({ subscribe: {} });
      const agent = await client.createAgent({
        cwd,
        title: "restart-bg-work",
        ...getRealProviderConfig("claude"),
      });
      await client.sendMessage(
        agent.id,
        [
          "Use the Bash tool with run_in_background set to true.",
          "Run exactly: sleep 300",
          "Do not wait for the task result.",
          "Reply immediately with exactly: SPAWNED",
        ].join(" "),
      );
      const finish = await client.waitForFinish(agent.id, 240_000);
      expect(finish.status).toBe("idle");
      const before = await client.fetchAgent(agent.id);
      console.log("before restart", before?.agent.status, before?.agent.backgroundWork);
      expect(before?.agent.status).toBe("idle");
      expect(before?.agent.backgroundWork?.count ?? 0).toBeGreaterThan(0);

      await client.close();
      await daemon.close();

      daemon = await start();
      client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
      await client.connect();
      await client.fetchAgents({ subscribe: {} });
      const resumed = async () => {
        const timeline = await client.fetchAgentTimeline(agent.id, {
          direction: "tail",
          limit: 0,
          projection: "canonical",
        });
        return timeline.entries.some(
          (entry) =>
            entry.item.type === "user_message" &&
            String((entry.item as { text?: string }).text).includes("Resume working."),
        );
      };
      // Wait long enough for restart recovery, which starts right after the connection opens.
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      const after = await client.fetchAgent(agent.id);
      console.log("after restart", after?.agent.status, after?.agent.backgroundWork);
      expect(await resumed()).toBe(true);
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close().catch(() => undefined);
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 420_000);
  test("a mid-turn Claude agent is resumed after restart", async () => {
    const logger = pino({ level: "silent" });
    const cwd = mkdtempSync(path.join(tmpdir(), "restart-bg-work-cwd-"));
    const home = mkdtempSync(path.join(tmpdir(), "restart-bg-work-home-"));
    const start = () =>
      createTestPaseoDaemon({
        agentClients: createRealProviderClients(["claude"], logger),
        logger,
        paseoHomeRoot: home,
        cleanup: false,
        resumeOnStartup: true,
      });
    let daemon = await start();
    let client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    try {
      await client.connect();
      await client.fetchAgents({ subscribe: {} });
      const agent = await client.createAgent({
        cwd,
        title: "restart-bg-work",
        ...getRealProviderConfig("claude"),
      });
      await client.sendMessage(
        agent.id,
        [
          "Use the Bash tool in the foreground (not in the background).",
          "Run exactly: python3 -c 'import time; time.sleep(40)'",
          "Then reply with exactly: DONE",
        ].join(" "),
      );
      await client.waitForAgentUpsert(agent.id, (s) => s.status === "running", 60_000);
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      const before = await client.fetchAgent(agent.id);
      console.log("before restart", before?.agent.status, before?.agent.backgroundWork);
      expect(before?.agent.status).toBe("running");

      await client.close();
      await daemon.close();

      daemon = await start();
      client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
      await client.connect();
      await client.fetchAgents({ subscribe: {} });
      const resumed = async () => {
        const timeline = await client.fetchAgentTimeline(agent.id, {
          direction: "tail",
          limit: 0,
          projection: "canonical",
        });
        return timeline.entries.some(
          (entry) =>
            entry.item.type === "user_message" &&
            String((entry.item as { text?: string }).text).includes("Resume working."),
        );
      };
      // Wait long enough for restart recovery, which starts right after the connection opens.
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      const after = await client.fetchAgent(agent.id);
      console.log("after restart", after?.agent.status, after?.agent.backgroundWork);
      expect(await resumed()).toBe(true);
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close().catch(() => undefined);
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 420_000);
});
