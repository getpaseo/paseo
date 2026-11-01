import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import { CodexAppServerAgentClient } from "../agent/providers/codex-app-server-agent.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createMessageCollector } from "../test-utils/message-collector.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { canRunRealProvider } from "./real-provider-test-config.js";

test("keeps two concurrent startup steer messages in one real Codex turn", async (context) => {
  if (!(await canRunRealProvider("codex"))) {
    context.skip();
    return;
  }
  const cwd = mkdtempSync(path.join(tmpdir(), "codex-steer-starting-"));
  const logger = pino({ level: "silent" });
  const daemon = await createTestPaseoDaemon({
    agentClients: { codex: new CodexAppServerAgentClient(logger) },
    logger,
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const collector = createMessageCollector(client);
  const subscriptions: ReturnType<DaemonClient["subscribeAgentTimeline"]>[] = [];
  try {
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const agent = await client.createAgent({
        cwd,
        provider: "codex",
        modeId: "full-access",
      });
      const subscription = client.subscribeAgentTimeline(agent.id, () => {});
      subscriptions.push(subscription);
      await subscription.ready;
      await Promise.all([
        client.sendAgentMessage(agent.id, "Reply exactly: FIRST", {
          messageId: `first-${attempt}`,
          activeTurnBehavior: "steer",
        }),
        client.sendAgentMessage(agent.id, "Reply exactly: SECOND", {
          messageId: `second-${attempt}`,
          activeTurnBehavior: "steer",
        }),
      ]);
      await client.waitForFinish(agent.id, 90_000);
      const timeline = await client.fetchAgentTimeline(agent.id, { limit: 100 });
      const users = timeline.entries.filter((entry) => entry.item.type === "user_message");
      const events = collector.messages.flatMap((message) =>
        message.type === "agent_stream" && message.payload.agentId === agent.id
          ? [message.payload.event]
          : [],
      );
      expect(users.map((entry) => entry.item.text).sort()).toEqual([
        "Reply exactly: FIRST",
        "Reply exactly: SECOND",
      ]);
      expect(new Set(users.map((entry) => entry.turnId)).size).toBe(1);
      expect(events.filter((event) => event.type === "turn_started")).toHaveLength(1);
      expect(
        events.filter((event) => event.type === "turn_canceled" || event.type === "turn_failed"),
      ).toHaveLength(0);
      expect(
        timeline.entries.some(
          (entry) =>
            entry.item.type === "assistant_message" && entry.item.text.includes("[System Error]"),
        ),
      ).toBe(false);
    }
  } finally {
    await Promise.all(subscriptions.map((subscription) => subscription.release()));
    collector.unsubscribe();
    await client.close();
    await daemon.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 300_000);
