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
 * Core UX principle: The user is ONE person across all devices.
 * We want to notify them where they'll see it.
 *
 * Rules:
 * 1. If user is actively looking at the agent (focused + visible + recent activity) → no notification
 * 2. If user is on a device but looking elsewhere → notify on that device
 * 3. If web is stale (>2min no activity) but mobile is connected → notify mobile, not web
 * 4. Mobile is the fallback - always notify if connected and web is stale
 * 5. Switching tabs (appVisible=false) with recent activity → NO notification (user is still at computer)
 *
 * Heartbeat contains:
 * - deviceType: "web" | "mobile"
 * - focusedAgentId: which agent they're looking at (null if app not visible)
 * - lastActivityAt: timestamp of last user interaction
 * - appVisible: whether the app/tab is in foreground
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

  // ===========================================================================
  // SINGLE CLIENT SCENARIOS
  // ===========================================================================

  describe("single client - basic cases", () => {
    test("no notification when actively focused on agent", async () => {
      client1 = await createClient();

      const agent = await client1.createAgent({
        provider: "claude",
        model: "claude-haiku-4-5",
        cwd: "/tmp",
        title: "Active Focus Test",
      });

      client1.sendHeartbeat({
        deviceType: "web",
        focusedAgentId: agent.id,
        lastActivityAt: new Date().toISOString(),
        appVisible: true,
      });

      await new Promise((r) => setTimeout(r, 100));

      const attentionPromise = waitForAttentionRequired(client1, agent.id);
      await client1.sendMessage(agent.id, "Say 'hello' and nothing else");

      const attention = await attentionPromise;

      expect(attention.reason).toBe("finished");
      expect(attention.shouldNotify).toBe(false);
    }, 120000);

    test("notification when focused on different agent", async () => {
      client1 = await createClient();

      const agent1 = await client1.createAgent({
        provider: "claude",
        model: "claude-haiku-4-5",
        cwd: "/tmp",
        title: "Agent 1",
      });

      const agent2 = await client1.createAgent({
        provider: "claude",
        model: "claude-haiku-4-5",
        cwd: "/tmp",
        title: "Agent 2",
      });

      // User is looking at agent2, not agent1
      client1.sendHeartbeat({
        deviceType: "web",
        focusedAgentId: agent2.id,
        lastActivityAt: new Date().toISOString(),
        appVisible: true,
      });

      await new Promise((r) => setTimeout(r, 100));

      const attentionPromise = waitForAttentionRequired(client1, agent1.id);
      await client1.sendMessage(agent1.id, "Say 'hello' and nothing else");

      const attention = await attentionPromise;

      expect(attention.reason).toBe("finished");
      expect(attention.shouldNotify).toBe(true);
    }, 120000);

    test("no notification when app is not visible but activity is recent (user just switched tabs)", async () => {
      client1 = await createClient();

      const agent = await client1.createAgent({
        provider: "claude",
        model: "claude-haiku-4-5",
        cwd: "/tmp",
        title: "App Hidden Test",
      });

      // User switched away from the app but was active recently - they're still at the computer
      client1.sendHeartbeat({
        deviceType: "web",
        focusedAgentId: null, // null because app not visible
        lastActivityAt: new Date().toISOString(),
        appVisible: false,
      });

      await new Promise((r) => setTimeout(r, 100));

      const attentionPromise = waitForAttentionRequired(client1, agent.id);
      await client1.sendMessage(agent.id, "Say 'hello' and nothing else");

      const attention = await attentionPromise;

      expect(attention.reason).toBe("finished");
      expect(attention.shouldNotify).toBe(false);
    }, 120000);

    test("notification when activity is stale (user walked away for 2+ minutes)", async () => {
      client1 = await createClient();

      const agent = await client1.createAgent({
        provider: "claude",
        model: "claude-haiku-4-5",
        cwd: "/tmp",
        title: "Stale Activity Test",
      });

      // User had agent focused but no activity for 2+ minutes (stale threshold)
      const staleTime = new Date(Date.now() - 125_000).toISOString(); // 2min 5sec ago
      client1.sendHeartbeat({
        deviceType: "web",
        focusedAgentId: agent.id,
        lastActivityAt: staleTime,
        appVisible: true,
      });

      await new Promise((r) => setTimeout(r, 100));

      const attentionPromise = waitForAttentionRequired(client1, agent.id);
      await client1.sendMessage(agent.id, "Say 'hello' and nothing else");

      const attention = await attentionPromise;

      expect(attention.reason).toBe("finished");
      expect(attention.shouldNotify).toBe(true);
    }, 120000);

    test("notification when no heartbeat received (legacy/new client)", async () => {
      client1 = await createClient();

      const agent = await client1.createAgent({
        provider: "claude",
        model: "claude-haiku-4-5",
        cwd: "/tmp",
        title: "No Heartbeat Test",
      });

      // Don't send any heartbeat - simulate legacy client

      const attentionPromise = waitForAttentionRequired(client1, agent.id);
      await client1.sendMessage(agent.id, "Say 'hello' and nothing else");

      const attention = await attentionPromise;

      expect(attention.reason).toBe("finished");
      expect(attention.shouldNotify).toBe(true);
    }, 120000);
  });

  // ===========================================================================
  // TWO CLIENTS - SAME DEVICE TYPE (e.g., two browser tabs)
  // ===========================================================================

  describe("two web clients", () => {
    test("no notification when other web client is active on agent", async () => {
      client1 = await createClient();
      client2 = await createClient();

      const agent = await client1.createAgent({
        provider: "claude",
        model: "claude-haiku-4-5",
        cwd: "/tmp",
        title: "Two Tabs Test",
      });

      // Client 1: not focused on agent
      client1.sendHeartbeat({
        deviceType: "web",
        focusedAgentId: null,
        lastActivityAt: new Date().toISOString(),
        appVisible: false,
      });

      // Client 2: actively focused on agent
      client2.sendHeartbeat({
        deviceType: "web",
        focusedAgentId: agent.id,
        lastActivityAt: new Date().toISOString(),
        appVisible: true,
      });

      await new Promise((r) => setTimeout(r, 100));

      const attention1Promise = waitForAttentionRequired(client1, agent.id);
      const attention2Promise = waitForAttentionRequired(client2, agent.id);
      await client1.sendMessage(agent.id, "Say 'hello' and nothing else");

      const [attention1, attention2] = await Promise.all([
        attention1Promise,
        attention2Promise,
      ]);

      // Neither should notify - user is actively watching on client2
      expect(attention1.shouldNotify).toBe(false);
      expect(attention2.shouldNotify).toBe(false);
    }, 120000);

    test("both notify when both web clients are inactive", async () => {
      client1 = await createClient();
      client2 = await createClient();

      const agent = await client1.createAgent({
        provider: "claude",
        model: "claude-haiku-4-5",
        cwd: "/tmp",
        title: "Both Inactive Test",
      });

      const staleTime = new Date(Date.now() - 120_000).toISOString();

      // Both clients stale
      client1.sendHeartbeat({
        deviceType: "web",
        focusedAgentId: null,
        lastActivityAt: staleTime,
        appVisible: false,
      });

      client2.sendHeartbeat({
        deviceType: "web",
        focusedAgentId: null,
        lastActivityAt: staleTime,
        appVisible: false,
      });

      await new Promise((r) => setTimeout(r, 100));

      const attention1Promise = waitForAttentionRequired(client1, agent.id);
      const attention2Promise = waitForAttentionRequired(client2, agent.id);
      await client1.sendMessage(agent.id, "Say 'hello' and nothing else");

      const [attention1, attention2] = await Promise.all([
        attention1Promise,
        attention2Promise,
      ]);

      // Both should notify - no one is watching
      expect(attention1.shouldNotify).toBe(true);
      expect(attention2.shouldNotify).toBe(true);
    }, 120000);
  });

  // ===========================================================================
  // WEB + MOBILE - DEVICE PRIORITY SCENARIOS
  // ===========================================================================

  describe("web and mobile clients", () => {
    test("no notification to either when user actively on agent (web)", async () => {
      client1 = await createClient(); // web
      client2 = await createClient(); // mobile

      const agent = await client1.createAgent({
        provider: "claude",
        model: "claude-haiku-4-5",
        cwd: "/tmp",
        title: "Web Active Test",
      });

      // Web: actively focused
      client1.sendHeartbeat({
        deviceType: "web",
        focusedAgentId: agent.id,
        lastActivityAt: new Date().toISOString(),
        appVisible: true,
      });

      // Mobile: app in background
      client2.sendHeartbeat({
        deviceType: "mobile",
        focusedAgentId: null,
        lastActivityAt: new Date(Date.now() - 300_000).toISOString(), // 5 min ago
        appVisible: false,
      });

      await new Promise((r) => setTimeout(r, 100));

      const attention1Promise = waitForAttentionRequired(client1, agent.id);
      const attention2Promise = waitForAttentionRequired(client2, agent.id);
      await client1.sendMessage(agent.id, "Say 'hello' and nothing else");

      const [attention1, attention2] = await Promise.all([
        attention1Promise,
        attention2Promise,
      ]);

      // Neither should notify - user sees it on web
      expect(attention1.shouldNotify).toBe(false);
      expect(attention2.shouldNotify).toBe(false);
    }, 120000);

    test("no notification to either when user actively on agent (mobile)", async () => {
      client1 = await createClient(); // web
      client2 = await createClient(); // mobile

      const agent = await client1.createAgent({
        provider: "claude",
        model: "claude-haiku-4-5",
        cwd: "/tmp",
        title: "Mobile Active Test",
      });

      // Web: tab hidden, stale
      client1.sendHeartbeat({
        deviceType: "web",
        focusedAgentId: null,
        lastActivityAt: new Date(Date.now() - 120_000).toISOString(),
        appVisible: false,
      });

      // Mobile: actively focused on agent
      client2.sendHeartbeat({
        deviceType: "mobile",
        focusedAgentId: agent.id,
        lastActivityAt: new Date().toISOString(),
        appVisible: true,
      });

      await new Promise((r) => setTimeout(r, 100));

      const attention1Promise = waitForAttentionRequired(client1, agent.id);
      const attention2Promise = waitForAttentionRequired(client2, agent.id);
      await client1.sendMessage(agent.id, "Say 'hello' and nothing else");

      const [attention1, attention2] = await Promise.all([
        attention1Promise,
        attention2Promise,
      ]);

      // Neither should notify - user sees it on mobile
      expect(attention1.shouldNotify).toBe(false);
      expect(attention2.shouldNotify).toBe(false);
    }, 120000);

    test("notify mobile only when web is stale", async () => {
      client1 = await createClient(); // web
      client2 = await createClient(); // mobile

      const agent = await client1.createAgent({
        provider: "claude",
        model: "claude-haiku-4-5",
        cwd: "/tmp",
        title: "Web Stale Test",
      });

      // Web: stale (user walked away from computer)
      client1.sendHeartbeat({
        deviceType: "web",
        focusedAgentId: agent.id, // was looking at agent
        lastActivityAt: new Date(Date.now() - 120_000).toISOString(), // but 2 min ago
        appVisible: true,
      });

      // Mobile: connected but not active (phone in pocket)
      client2.sendHeartbeat({
        deviceType: "mobile",
        focusedAgentId: null,
        lastActivityAt: new Date(Date.now() - 300_000).toISOString(), // 5 min ago
        appVisible: false,
      });

      await new Promise((r) => setTimeout(r, 100));

      const attention1Promise = waitForAttentionRequired(client1, agent.id);
      const attention2Promise = waitForAttentionRequired(client2, agent.id);
      await client1.sendMessage(agent.id, "Say 'hello' and nothing else");

      const [attention1, attention2] = await Promise.all([
        attention1Promise,
        attention2Promise,
      ]);

      // Web stale → don't notify web, notify mobile instead
      expect(attention1.shouldNotify).toBe(false);
      expect(attention2.shouldNotify).toBe(true);
    }, 120000);

    test("notify web when user active on web but looking at different agent", async () => {
      client1 = await createClient(); // web
      client2 = await createClient(); // mobile

      const agent1 = await client1.createAgent({
        provider: "claude",
        model: "claude-haiku-4-5",
        cwd: "/tmp",
        title: "Agent 1",
      });

      const agent2 = await client1.createAgent({
        provider: "claude",
        model: "claude-haiku-4-5",
        cwd: "/tmp",
        title: "Agent 2",
      });

      // Web: active but looking at agent2
      client1.sendHeartbeat({
        deviceType: "web",
        focusedAgentId: agent2.id,
        lastActivityAt: new Date().toISOString(),
        appVisible: true,
      });

      // Mobile: not active
      client2.sendHeartbeat({
        deviceType: "mobile",
        focusedAgentId: null,
        lastActivityAt: new Date(Date.now() - 300_000).toISOString(),
        appVisible: false,
      });

      await new Promise((r) => setTimeout(r, 100));

      const attention1Promise = waitForAttentionRequired(client1, agent1.id);
      const attention2Promise = waitForAttentionRequired(client2, agent1.id);
      await client1.sendMessage(agent1.id, "Say 'hello' and nothing else");

      const [attention1, attention2] = await Promise.all([
        attention1Promise,
        attention2Promise,
      ]);

      // User is active on web, notify them there (they'll see it)
      expect(attention1.shouldNotify).toBe(true);
      // Don't also notify mobile - user is at the computer
      expect(attention2.shouldNotify).toBe(false);
    }, 120000);

    test("notify both when both devices inactive and no one watching agent", async () => {
      client1 = await createClient(); // web
      client2 = await createClient(); // mobile

      const agent = await client1.createAgent({
        provider: "claude",
        model: "claude-haiku-4-5",
        cwd: "/tmp",
        title: "Both Inactive Test",
      });

      const staleTime = new Date(Date.now() - 120_000).toISOString();

      // Web: stale
      client1.sendHeartbeat({
        deviceType: "web",
        focusedAgentId: null,
        lastActivityAt: staleTime,
        appVisible: false,
      });

      // Mobile: also stale (but mobile should still notify as fallback)
      client2.sendHeartbeat({
        deviceType: "mobile",
        focusedAgentId: null,
        lastActivityAt: staleTime,
        appVisible: false,
      });

      await new Promise((r) => setTimeout(r, 100));

      const attention1Promise = waitForAttentionRequired(client1, agent.id);
      const attention2Promise = waitForAttentionRequired(client2, agent.id);
      await client1.sendMessage(agent.id, "Say 'hello' and nothing else");

      const [attention1, attention2] = await Promise.all([
        attention1Promise,
        attention2Promise,
      ]);

      // Mobile always notifies when no one is watching
      // Web is stale so don't bother notifying there
      expect(attention1.shouldNotify).toBe(false); // web stale
      expect(attention2.shouldNotify).toBe(true);  // mobile fallback
    }, 120000);
  });

  // ===========================================================================
  // EDGE CASES
  // ===========================================================================

  describe("edge cases", () => {
    test("mobile notifies even with no heartbeat when web is stale", async () => {
      client1 = await createClient(); // web
      client2 = await createClient(); // mobile - no heartbeat

      const agent = await client1.createAgent({
        provider: "claude",
        model: "claude-haiku-4-5",
        cwd: "/tmp",
        title: "Mobile No Heartbeat Test",
      });

      // Web: stale
      client1.sendHeartbeat({
        deviceType: "web",
        focusedAgentId: agent.id,
        lastActivityAt: new Date(Date.now() - 120_000).toISOString(),
        appVisible: true,
      });

      // Mobile: never sent heartbeat (new connection)
      // Should still receive notification as fallback

      await new Promise((r) => setTimeout(r, 100));

      const attention1Promise = waitForAttentionRequired(client1, agent.id);
      const attention2Promise = waitForAttentionRequired(client2, agent.id);
      await client1.sendMessage(agent.id, "Say 'hello' and nothing else");

      const [attention1, attention2] = await Promise.all([
        attention1Promise,
        attention2Promise,
      ]);

      // Web stale → no notification
      // Mobile has no heartbeat → treat as should notify (we don't know device type)
      expect(attention1.shouldNotify).toBe(false);
      expect(attention2.shouldNotify).toBe(true);
    }, 120000);

    test("no notification when app not visible but activity recent (switched tabs recently)", async () => {
      client1 = await createClient();

      const agent = await client1.createAgent({
        provider: "claude",
        model: "claude-haiku-4-5",
        cwd: "/tmp",
        title: "Tab Switch Test",
      });

      // User just switched tabs but was active 10 seconds ago - still at computer
      client1.sendHeartbeat({
        deviceType: "web",
        focusedAgentId: null, // not focused - tab hidden
        lastActivityAt: new Date(Date.now() - 10_000).toISOString(), // 10s ago
        appVisible: false,
      });

      await new Promise((r) => setTimeout(r, 100));

      const attentionPromise = waitForAttentionRequired(client1, agent.id);
      await client1.sendMessage(agent.id, "Say 'hello' and nothing else");

      const attention = await attentionPromise;

      // User is at the computer (recent activity) - no notification needed
      expect(attention.shouldNotify).toBe(false);
    }, 120000);

    test("no notification to either when both have recent activity (user is present)", async () => {
      client1 = await createClient(); // web
      client2 = await createClient(); // mobile

      const agent = await client1.createAgent({
        provider: "claude",
        model: "claude-haiku-4-5",
        cwd: "/tmp",
        title: "Both Recent Activity Test",
      });

      // Web: tab hidden but recent activity (user at computer, switched tabs)
      client1.sendHeartbeat({
        deviceType: "web",
        focusedAgentId: null,
        lastActivityAt: new Date(Date.now() - 30_000).toISOString(), // 30s ago
        appVisible: false,
      });

      // Mobile: connected, also recent activity
      client2.sendHeartbeat({
        deviceType: "mobile",
        focusedAgentId: null,
        lastActivityAt: new Date(Date.now() - 30_000).toISOString(),
        appVisible: false,
      });

      await new Promise((r) => setTimeout(r, 100));

      const attention1Promise = waitForAttentionRequired(client1, agent.id);
      const attention2Promise = waitForAttentionRequired(client2, agent.id);
      await client1.sendMessage(agent.id, "Say 'hello' and nothing else");

      const [attention1, attention2] = await Promise.all([
        attention1Promise,
        attention2Promise,
      ]);

      // Both have recent activity - user is present, no notification needed
      expect(attention1.shouldNotify).toBe(false);
      expect(attention2.shouldNotify).toBe(false);
    }, 120000);
  });
});
