import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import { DaemonClient } from "./test-utils/daemon-client.js";
import { getFullAccessConfig } from "./daemon-e2e/agent-configs.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";

test("guards one exact idle agent and keeps message receipts across daemon restart", async () => {
  const paseoHomeRoot = await mkdtemp(path.join(tmpdir(), "paseo-guarded-send-home-"));
  const staticDir = await mkdtemp(path.join(tmpdir(), "paseo-guarded-send-static-"));
  const cwd = await mkdtemp(path.join(tmpdir(), "paseo-guarded-send-cwd-"));
  let starts = 0;
  const agentClients = createTestAgentClients({
    onStartTurn: () => {
      starts += 1;
    },
  });
  let daemon = await createTestPaseoDaemon({
    paseoHomeRoot,
    staticDir,
    cleanup: false,
    agentClients,
  });
  let client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    clientId: "guarded-send-before-restart",
    reconnect: { enabled: false },
  });

  try {
    await client.connect();
    expect(client.getLastServerInfoMessage()?.features?.agentMessageSendGuard).toBe(true);
    await client.fetchAgents({ subscribe: { subscriptionId: "guarded-send" } });
    const agent = await client.createAgent({
      config: { ...getFullAccessConfig("codex"), cwd },
    });
    const guard = {
      expectedAgentId: agent.id,
      expectedUpdatedAt: agent.updatedAt,
      expectedStatus: "idle" as const,
      expectedArchivedAt: null,
    };

    await expect(
      client.sendAgentMessage(agent.id, "first guarded turn", {
        messageId: "guarded-message",
        guard,
      }),
    ).resolves.toMatchObject({
      accepted: true,
      replayed: false,
      guard: { matched: true, reason: null },
    });
    await expect(client.waitForFinish(agent.id, 10_000)).resolves.toMatchObject({ status: "idle" });
    expect(starts).toBe(1);

    await expect(
      client.sendAgentMessage(agent.id, "first guarded turn", {
        messageId: "guarded-message",
        guard,
      }),
    ).resolves.toMatchObject({ accepted: true, replayed: true });
    await expect(
      client.getAgentMessageReceipt({ id: agent.id, messageId: "guarded-message" }),
    ).resolves.toEqual({
      agentId: agent.id,
      messageId: "guarded-message",
      state: "completed",
    });
    expect(starts).toBe(1);

    await client.close();
    await daemon.close();
    daemon = await createTestPaseoDaemon({
      paseoHomeRoot,
      staticDir,
      cleanup: false,
      agentClients,
    });
    client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      clientId: "guarded-send-after-restart",
      reconnect: { enabled: false },
    });
    await client.connect();

    await expect(
      client.sendAgentMessage(agent.id, "first guarded turn", {
        messageId: "guarded-message",
        guard,
      }),
    ).resolves.toMatchObject({ accepted: true, replayed: true });
    expect(starts).toBe(1);

    await client.refreshAgent(agent.id);
    const idle = await client.fetchAgent({ agentId: agent.id });
    expect(idle?.agent.status).toBe("idle");
    const currentGuard = {
      ...guard,
      expectedUpdatedAt: idle?.agent.updatedAt ?? "missing",
    };
    await expect(
      client.sendAgentMessage(agent.id, "stale observation", {
        messageId: "stale-guard",
        guard,
      }),
    ).resolves.toMatchObject({
      accepted: false,
      replayed: false,
      guard: { matched: false, reason: "updated_at_mismatch" },
    });
    await expect(
      client.getAgentMessageReceipt({ id: agent.id, messageId: "stale-guard" }),
    ).resolves.toMatchObject({ state: "missing" });

    await expect(
      client.sendAgentMessage(agent.id.slice(0, 8), "prefix must not select the seat", {
        messageId: "prefix-guard",
        guard: currentGuard,
      }),
    ).resolves.toMatchObject({
      accepted: false,
      guard: { matched: false, reason: "agent_id_mismatch" },
    });
    await expect(
      client.sendAgentMessage("missing-exact-agent", "missing seat must not send", {
        messageId: "missing-agent-guard",
        guard: { ...currentGuard, expectedAgentId: "missing-exact-agent" },
      }),
    ).resolves.toMatchObject({
      accepted: false,
      guard: { matched: false, reason: "agent_id_mismatch" },
    });

    await client.sendAgentMessage(agent.id, "emit 200 coalesced agent stream updates", {
      messageId: "ordinary-running-turn",
    });
    const running = await client.waitForAgentUpsert(
      agent.id,
      (snapshot) => snapshot.status === "running",
      10_000,
    );
    await expect(
      client.sendAgentMessage(agent.id, "must not replace running", {
        messageId: "running-guard",
        guard: { ...currentGuard, expectedUpdatedAt: running.updatedAt },
      }),
    ).resolves.toMatchObject({
      accepted: false,
      guard: { matched: false, reason: "not_idle" },
    });
    await expect(
      client.getAgentMessageReceipt({ id: agent.id, messageId: "running-guard" }),
    ).resolves.toMatchObject({ state: "missing" });
    expect(starts).toBe(2);
    await expect(client.waitForFinish(agent.id, 10_000)).resolves.toMatchObject({ status: "idle" });

    await client.archiveAgent(agent.id);
    const archived = await client.fetchAgent({ agentId: agent.id });
    expect(archived?.agent.archivedAt).not.toBeNull();
    await expect(
      client.sendAgentMessage(agent.id, "must not unarchive", {
        messageId: "archived-guard",
        guard: {
          ...currentGuard,
          expectedUpdatedAt: archived?.agent.updatedAt ?? "missing",
        },
      }),
    ).resolves.toMatchObject({
      accepted: false,
      guard: { matched: false, reason: "archived" },
    });
    await expect(
      client.getAgentMessageReceipt({ id: agent.id, messageId: "archived-guard" }),
    ).resolves.toMatchObject({ state: "missing" });
    const stillArchived = await client.fetchAgent({ agentId: agent.id });
    expect(stillArchived?.agent.archivedAt).not.toBeNull();
    expect(starts).toBe(2);
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close().catch(() => undefined);
    await Promise.all([
      rm(paseoHomeRoot, { recursive: true, force: true }),
      rm(staticDir, { recursive: true, force: true }),
      rm(cwd, { recursive: true, force: true }),
    ]);
  }
}, 60_000);
