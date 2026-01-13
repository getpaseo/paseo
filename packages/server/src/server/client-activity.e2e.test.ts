import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
} from "vitest";
import {
  createTestPaseoDaemon,
  type TestPaseoDaemon,
} from "./test-utils/paseo-daemon.js";
import { DaemonClient } from "./test-utils/daemon-client.js";
import type { AgentStreamEventPayload } from "../shared/messages.js";

/**
 * Tests for client activity tracking and smart notifications.
 *
 * The server tracks client activity via heartbeats to determine whether
 * to notify users when agents need attention. If any client is actively
 * viewing an agent, shouldNotify is false. Otherwise, shouldNotify is true.
 *
 * Activity is determined by:
 * - focusedAgentId: which agent the client is viewing
 * - lastActivityAt: timestamp of last user interaction (must be within 60s)
 */
describe("client activity tracking", () => {
  let daemon: TestPaseoDaemon;
  let client1: DaemonClient;
  let client2: DaemonClient;

  beforeEach(async () => {
    daemon = await createTestPaseoDaemon();
  });

  afterEach(async () => {
    if (client1) await client1.close().catch(() => {});
    if (client2) await client2.close().catch(() => {});
    await daemon.close();
  }, 30000);

  async function createClient(): Promise<DaemonClient> {
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      authHeader: daemon.agentMcpAuthHeader,
      messageQueueLimit: null,
    });
    await client.connect();
    return client;
  }

  function waitForAttentionRequired(
    client: DaemonClient,
    agentId: string,
    timeout = 60000
  ): Promise<Extract<AgentStreamEventPayload, { type: "attention_required" }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout waiting for attention_required (${timeout}ms)`));
      }, timeout);

      const cleanup = client.on("agent_stream", (msg) => {
        if (msg.type !== "agent_stream") return;
        if (msg.payload.agentId !== agentId) return;
        if (msg.payload.event.type !== "attention_required") return;

        clearTimeout(timer);
        cleanup();
        resolve(msg.payload.event);
      });
    });
  }

  test("shouldNotify is false when client is active and focused on agent", async () => {
    client1 = await createClient();

    const agent = await client1.createAgent({
      provider: "codex",
      cwd: "/tmp",
      title: "Activity Test",
    });

    client1.sendHeartbeat({
      focusedAgentId: agent.id,
      lastActivityAt: new Date().toISOString(),
    });

    await new Promise((r) => setTimeout(r, 100));

    const attentionPromise = waitForAttentionRequired(client1, agent.id);
    await client1.sendMessage(agent.id, "Say 'hello' and nothing else");

    const attention = await attentionPromise;

    expect(attention.reason).toBe("finished");
    expect(attention.shouldNotify).toBe(false);
  }, 120000);

  test("shouldNotify is true when client has stale activity", async () => {
    client1 = await createClient();

    const agent = await client1.createAgent({
      provider: "codex",
      cwd: "/tmp",
      title: "Stale Activity Test",
    });

    const staleTime = new Date(Date.now() - 120_000).toISOString();
    client1.sendHeartbeat({
      focusedAgentId: agent.id,
      lastActivityAt: staleTime,
    });

    await new Promise((r) => setTimeout(r, 100));

    const attentionPromise = waitForAttentionRequired(client1, agent.id);
    await client1.sendMessage(agent.id, "Say 'hello' and nothing else");

    const attention = await attentionPromise;

    expect(attention.reason).toBe("finished");
    expect(attention.shouldNotify).toBe(true);
  }, 120000);

  test("shouldNotify is true when client is focused on different agent", async () => {
    client1 = await createClient();

    const agent1 = await client1.createAgent({
      provider: "codex",
      cwd: "/tmp",
      title: "Agent 1",
    });

    const agent2 = await client1.createAgent({
      provider: "codex",
      cwd: "/tmp",
      title: "Agent 2",
    });

    client1.sendHeartbeat({
      focusedAgentId: agent2.id,
      lastActivityAt: new Date().toISOString(),
    });

    await new Promise((r) => setTimeout(r, 100));

    const attentionPromise = waitForAttentionRequired(client1, agent1.id);
    await client1.sendMessage(agent1.id, "Say 'hello' and nothing else");

    const attention = await attentionPromise;

    expect(attention.reason).toBe("finished");
    expect(attention.shouldNotify).toBe(true);
  }, 120000);

  test("shouldNotify is false when another client is active on agent", async () => {
    client1 = await createClient();
    client2 = await createClient();

    const agent = await client1.createAgent({
      provider: "codex",
      cwd: "/tmp",
      title: "Multi-client Test",
    });

    client1.sendHeartbeat({
      focusedAgentId: null,
      lastActivityAt: new Date(Date.now() - 120_000).toISOString(),
    });

    client2.sendHeartbeat({
      focusedAgentId: agent.id,
      lastActivityAt: new Date().toISOString(),
    });

    await new Promise((r) => setTimeout(r, 100));

    const attentionPromise = waitForAttentionRequired(client1, agent.id);
    await client1.sendMessage(agent.id, "Say 'hello' and nothing else");

    const attention = await attentionPromise;

    expect(attention.reason).toBe("finished");
    expect(attention.shouldNotify).toBe(false);
  }, 120000);

  test("shouldNotify is true when no heartbeat received", async () => {
    client1 = await createClient();

    const agent = await client1.createAgent({
      provider: "codex",
      cwd: "/tmp",
      title: "No Heartbeat Test",
    });

    const attentionPromise = waitForAttentionRequired(client1, agent.id);
    await client1.sendMessage(agent.id, "Say 'hello' and nothing else");

    const attention = await attentionPromise;

    expect(attention.reason).toBe("finished");
    expect(attention.shouldNotify).toBe(true);
  }, 120000);
});
