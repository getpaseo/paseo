import { beforeAll, beforeEach, describe, test, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import {
  canRunRealProvider,
  createRealProviderClients,
  getRealProviderConfig,
} from "./real-provider-test-config.js";

async function readStatusAndPendingIds(
  client: DaemonClient,
  agentId: string,
): Promise<{ status: string; pendingIds: string[] }> {
  const fetched = await client.fetchAgent(agentId);
  const snapshot = fetched!.agent;
  const pendingIds = (snapshot.pendingPermissions ?? []).map((pending) => pending.id);
  return { status: snapshot.status, pendingIds };
}

describe("daemon E2E (real opencode) - a message sent instead of answering a question", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await canRunRealProvider("opencode");
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  test("removes the superseded question from the pending list", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "daemon-real-opencode-question-"));
    const logger = pino({ level: "silent" });
    const daemon = await createTestPaseoDaemon({
      agentClients: createRealProviderClients(["opencode"], logger),
      logger,
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    await client.connect();
    await client.fetchAgents({ subscribe: {} });

    try {
      const agent = await client.createAgent({
        ...getRealProviderConfig("opencode"),
        cwd,
        title: "OpenCode superseded question",
      });

      await client.sendMessage(
        agent.id,
        [
          "Use the question tool to ask me exactly one clarifying question:",
          "What color should the button be?",
          "Wait for my answer before doing anything else.",
        ].join(" "),
      );
      await client.waitForAgentUpsert(
        agent.id,
        (snapshot) => snapshot.pendingPermissions?.[0]?.kind === "question",
        120_000,
      );

      // The app sends with the default send setting, which steers the running turn.
      await client.sendMessage(agent.id, "Never mind the question. Reply with the word done.", {
        activeTurnBehavior: "steer",
      });
      // OpenCode rejects the question and runs the steer message to completion.
      await expect
        .poll(() => readStatusAndPendingIds(client, agent.id), {
          timeout: 120_000,
          interval: 1_000,
        })
        .toEqual({ status: "idle", pendingIds: [] });
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 300_000);
});
