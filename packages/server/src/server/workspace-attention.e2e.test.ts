import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import type { SessionOutboundMessage } from "./messages.js";
import { DaemonClient } from "./test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";

test.each([
  { closed: false, batch: false },
  { closed: true, batch: false },
  { closed: false, batch: true },
  { closed: true, batch: true },
])(
  "clearing workspace attention reaches independent subscribers (closed=$closed, batch=$batch)",
  async ({ closed, batch }) => {
    const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
    const clients = Array.from(
      { length: 4 },
      () => new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` }),
    );
    const [actor, observer, unreadObserver, quiet] = clients;
    const updates: SessionOutboundMessage[] = [];
    const unreadUpdates: SessionOutboundMessage[] = [];
    const quietUpdates: SessionOutboundMessage[] = [];
    try {
      await Promise.all(clients.map((client) => client.connect()));
      const agentIds: string[] = [];
      for (let index = 0; index < (batch ? 2 : 1); index += 1) {
        const cwd = path.join(daemon.staticDir, `workspace-${index}`);
        await mkdir(cwd);
        const agent = await actor.createAgent({ provider: "codex", cwd });
        await actor.sendMessage(agent.id, "Reply with OK.");
        await actor.waitForFinish(agent.id, 5000);
        await daemon.daemon.agentManager.clearAgentAttention(agent.id);
        if (closed) await daemon.daemon.agentManager.closeAgent(agent.id);
        agentIds.push(agent.id);
      }
      const snapshot = await observer.fetchAgents({
        filter: { includeArchived: true },
        subscribe: {},
      });
      const workspaceIds = agentIds.map(
        (id) => snapshot.entries.find((entry) => entry.agent.id === id)!.agent.workspaceId!,
      );
      expect(new Set(workspaceIds).size).toBe(agentIds.length);
      await unreadObserver.fetchAgents({ filter: { requiresAttention: true }, subscribe: {} });
      observer.subscribeRawMessages((message) => updates.push(message));
      unreadObserver.subscribeRawMessages((message) => unreadUpdates.push(message));
      quiet.subscribeRawMessages((message) => quietUpdates.push(message));
      const attention = (id: string) =>
        updates
          .flatMap((message) =>
            message.type === "agent_update" &&
            message.payload.kind === "upsert" &&
            message.payload.agent.id === id
              ? [message.payload.agent.requiresAttention]
              : [],
          )
          .at(-1);
      for (const [index, id] of agentIds.entries()) {
        await actor.markWorkspaceUnread(workspaceIds[index]);
        await expect.poll(() => attention(id)).toBe(true);
        await expect
          .poll(() =>
            unreadUpdates.some(
              (message) =>
                message.type === "agent_update" &&
                message.payload.kind === "upsert" &&
                message.payload.agent.id === id,
            ),
          )
          .toBe(true);
      }
      updates.length = unreadUpdates.length = quietUpdates.length = 0;
      await actor.clearWorkspaceAttention(batch ? workspaceIds : workspaceIds[0]);
      const fresh = await actor.fetchAgents();
      for (const id of agentIds) {
        expect(fresh.entries.find((entry) => entry.agent.id === id)?.agent.requiresAttention).toBe(
          false,
        );
        expect(Boolean(daemon.daemon.agentManager.getAgent(id))).toBe(!closed);
        await expect.poll(() => attention(id)).toBe(false);
        await expect
          .poll(() =>
            unreadUpdates.some(
              (message) =>
                message.type === "agent_update" &&
                message.payload.kind === "remove" &&
                message.payload.agentId === id,
            ),
          )
          .toBe(true);
      }
      expect(quietUpdates.filter((message) => message.type === "agent_update")).toEqual([]);
    } finally {
      await Promise.all(clients.map((client) => client.close()));
      await daemon.close();
    }
  },
);
