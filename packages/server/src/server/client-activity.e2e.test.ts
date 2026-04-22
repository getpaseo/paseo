import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { DaemonClient } from "./test-utils/daemon-client.js";
import type { AgentStreamEventPayload } from "../shared/messages.js";
import type { AgentSnapshotPayload } from "./messages.js";
import { PushService } from "./push/push-service.js";
import { PushTokenStore } from "./push/token-store.js";
import { PRESENCE_THRESHOLD_MS } from "./agent-attention-policy.js";

/**
 * Tests for client activity tracking and smart notifications.
 *
 * Core UX principle: The user is ONE person across all devices.
 * We want to notify them where they'll see it.
 *
 * Rules:
 * 1. If a present client is focused on the agent → no notification
 * 2. Otherwise, notify the most recently active present client
 * 3. If no client is present → send push for non-error attention
 *
 * Heartbeat contains:
 * - deviceType: "web" | "mobile"
 * - focusedAgentId: which agent they're looking at (null if app not visible)
 * - lastActivityAt: timestamp of last user interaction
 * - appVisible: whether the app/tab is in foreground
 */
describe("client activity tracking", () => {
  const TEST_PROVIDER = "claude";
  const TEST_MODEL = "haiku";
  const TEST_CWD = "/tmp";
  let daemon: TestPaseoDaemon;
  let client1: DaemonClient;
  let client2: DaemonClient;
  let sendPushSpy: ReturnType<typeof vi.spyOn>;
  let getAllTokensSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    sendPushSpy = vi.spyOn(PushService.prototype, "sendPush").mockResolvedValue(undefined);
    getAllTokensSpy = vi
      .spyOn(PushTokenStore.prototype, "getAllTokens")
      .mockReturnValue(["ExponentPushToken[activity-test]"]);
    daemon = await createTestPaseoDaemon();
  });

  afterEach(async () => {
    if (client1) await client1.close().catch(() => {});
    if (client2) await client2.close().catch(() => {});
    await daemon.close();
    sendPushSpy.mockRestore();
    getAllTokensSpy.mockRestore();
  }, 30000);

  async function createClient(): Promise<DaemonClient> {
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      messageQueueLimit: null,
    });
    await client.connect();
    return client;
  }

  async function createAgent(params: {
    client: DaemonClient;
    title: string;
  }): Promise<AgentSnapshotPayload> {
    return params.client.createAgent({
      provider: TEST_PROVIDER,
      model: TEST_MODEL,
      cwd: TEST_CWD,
      title: params.title,
      labels: { surface: "activity-test" },
    });
  }

  function waitForAttentionRequired(
    client: DaemonClient,
    agentId: string,
    timeout = 60000,
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

      const agent = await createAgent({
        client: client1,
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

      const agent1 = await createAgent({ client: client1, title: "Agent 1" });

      const agent2 = await createAgent({ client: client1, title: "Agent 2" });

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

    test("notification when app is not visible but activity is recent", async () => {
      client1 = await createClient();

      const agent = await createAgent({
        client: client1,
        title: "App Hidden Test",
      });

      // User switched away from the app but was active recently.
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
      expect(attention.shouldNotify).toBe(true);
    }, 120000);

    test("push fallback when activity is stale beyond the presence threshold", async () => {
      client1 = await createClient();

      const agent = await createAgent({
        client: client1,
        title: "Stale Activity Test",
      });

      // User had agent focused but no activity beyond the presence threshold.
      const staleTime = new Date(Date.now() - PRESENCE_THRESHOLD_MS - 5_000).toISOString();
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
      expect(attention.shouldNotify).toBe(false);
      expect(sendPushSpy).toHaveBeenCalledTimes(1);
    }, 120000);

    test("notification when no heartbeat received (legacy/new client)", async () => {
      client1 = await createClient();

      const agent = await createAgent({
        client: client1,
        title: "No Heartbeat Test",
      });

      // Don't send any heartbeat - simulate legacy client

      const attentionPromise = waitForAttentionRequired(client1, agent.id);
      await client1.sendMessage(agent.id, "Say 'hello' and nothing else");

      const attention = await attentionPromise;

      expect(attention.reason).toBe("finished");
      expect(attention.shouldNotify).toBe(false);
      expect(sendPushSpy).toHaveBeenCalledTimes(1);
    }, 120000);
  });

  // ===========================================================================
  // TWO CLIENTS - SAME DEVICE TYPE (e.g., two browser tabs)
  // ===========================================================================

  describe("two web clients", () => {
    test("no notification when other web client is active on agent", async () => {
      client1 = await createClient();
      client2 = await createClient();

      const agent = await createAgent({
        client: client1,
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

      const [attention1, attention2] = await Promise.all([attention1Promise, attention2Promise]);

      // Neither should notify - user is actively watching on client2
      expect(attention1.shouldNotify).toBe(false);
      expect(attention2.shouldNotify).toBe(false);
    }, 120000);

    test("pushes when both web clients are inactive", async () => {
      client1 = await createClient();
      client2 = await createClient();

      const agent = await createAgent({
        client: client1,
        title: "Both Inactive Test",
      });

      const staleTime = new Date(Date.now() - PRESENCE_THRESHOLD_MS - 5_000).toISOString();

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

      const [attention1, attention2] = await Promise.all([attention1Promise, attention2Promise]);

      // No stale client is selected for in-app; push handles the fallback.
      expect(attention1.shouldNotify).toBe(false);
      expect(attention2.shouldNotify).toBe(false);
      expect(sendPushSpy).toHaveBeenCalledTimes(1);
    }, 120000);

    test("notifies only the present Electron-style web client when Firefox is stale", async () => {
      client1 = await createClient();
      client2 = await createClient();

      const agent = await createAgent({
        client: client1,
        title: "Stale Firefox Present Electron Test",
      });

      client1.sendHeartbeat({
        deviceType: "web",
        focusedAgentId: agent.id,
        lastActivityAt: new Date(Date.now() - PRESENCE_THRESHOLD_MS - 60_000).toISOString(),
        appVisible: false,
      });

      client2.sendHeartbeat({
        deviceType: "web",
        focusedAgentId: null,
        lastActivityAt: new Date(Date.now() - 1_000).toISOString(),
        appVisible: false,
      });

      await new Promise((r) => setTimeout(r, 100));

      const attention1Promise = waitForAttentionRequired(client1, agent.id);
      const attention2Promise = waitForAttentionRequired(client2, agent.id);
      await client1.sendMessage(agent.id, "Say 'hello' and nothing else");

      const [attention1, attention2] = await Promise.all([attention1Promise, attention2Promise]);

      expect(attention1.shouldNotify).toBe(false);
      expect(attention2.shouldNotify).toBe(true);
      expect(sendPushSpy).not.toHaveBeenCalled();
    }, 120000);
  });

  // ===========================================================================
  // WEB + MOBILE - DEVICE PRIORITY SCENARIOS
  // ===========================================================================

  describe("web and mobile clients", () => {
    test("no notification to either when user actively on agent (web)", async () => {
      client1 = await createClient(); // web
      client2 = await createClient(); // mobile

      const agent = await createAgent({
        client: client1,
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
        lastActivityAt: new Date(Date.now() - PRESENCE_THRESHOLD_MS - 60_000).toISOString(),
        appVisible: false,
      });

      await new Promise((r) => setTimeout(r, 100));

      const attention1Promise = waitForAttentionRequired(client1, agent.id);
      const attention2Promise = waitForAttentionRequired(client2, agent.id);
      await client1.sendMessage(agent.id, "Say 'hello' and nothing else");

      const [attention1, attention2] = await Promise.all([attention1Promise, attention2Promise]);

      // Neither should notify - user sees it on web
      expect(attention1.shouldNotify).toBe(false);
      expect(attention2.shouldNotify).toBe(false);
    }, 120000);

    test("no notification to either when user actively on agent (mobile)", async () => {
      client1 = await createClient(); // web
      client2 = await createClient(); // mobile

      const agent = await createAgent({
        client: client1,
        title: "Mobile Active Test",
      });

      // Web: tab hidden, stale
      client1.sendHeartbeat({
        deviceType: "web",
        focusedAgentId: null,
        lastActivityAt: new Date(Date.now() - PRESENCE_THRESHOLD_MS - 5_000).toISOString(),
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

      const [attention1, attention2] = await Promise.all([attention1Promise, attention2Promise]);

      // Neither should notify - user sees it on mobile
      expect(attention1.shouldNotify).toBe(false);
      expect(attention2.shouldNotify).toBe(false);
    }, 120000);

    test("notify mobile only when web is stale and mobile is present", async () => {
      client1 = await createClient(); // web
      client2 = await createClient(); // mobile

      const agent = await createAgent({
        client: client1,
        title: "Web Stale Test",
      });

      // Web: stale (user walked away from computer)
      client1.sendHeartbeat({
        deviceType: "web",
        focusedAgentId: agent.id, // was looking at agent
        lastActivityAt: new Date(Date.now() - PRESENCE_THRESHOLD_MS - 5_000).toISOString(),
        appVisible: true,
      });

      // Mobile: present but not focused on the agent
      client2.sendHeartbeat({
        deviceType: "mobile",
        focusedAgentId: null,
        lastActivityAt: new Date().toISOString(),
        appVisible: false,
      });

      await new Promise((r) => setTimeout(r, 100));

      const attention1Promise = waitForAttentionRequired(client1, agent.id);
      const attention2Promise = waitForAttentionRequired(client2, agent.id);
      await client1.sendMessage(agent.id, "Say 'hello' and nothing else");

      const [attention1, attention2] = await Promise.all([attention1Promise, attention2Promise]);

      expect(attention1.shouldNotify).toBe(false);
      expect(attention2.shouldNotify).toBe(true);
      expect(sendPushSpy).not.toHaveBeenCalled();
    }, 120000);

    test("notify web when user active on web but looking at different agent", async () => {
      client1 = await createClient(); // web
      client2 = await createClient(); // mobile

      const agent1 = await createAgent({ client: client1, title: "Agent 1" });

      const agent2 = await createAgent({ client: client1, title: "Agent 2" });

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
        lastActivityAt: new Date(Date.now() - PRESENCE_THRESHOLD_MS - 60_000).toISOString(),
        appVisible: false,
      });

      await new Promise((r) => setTimeout(r, 100));

      const attention1Promise = waitForAttentionRequired(client1, agent1.id);
      const attention2Promise = waitForAttentionRequired(client2, agent1.id);
      await client1.sendMessage(agent1.id, "Say 'hello' and nothing else");

      const [attention1, attention2] = await Promise.all([attention1Promise, attention2Promise]);

      // User is active on web, notify them there (they'll see it)
      expect(attention1.shouldNotify).toBe(true);
      // Don't also notify mobile - user is at the computer
      expect(attention2.shouldNotify).toBe(false);
    }, 120000);

    test("pushes when both devices are inactive and no one is watching agent", async () => {
      client1 = await createClient(); // web
      client2 = await createClient(); // mobile

      const agent = await createAgent({
        client: client1,
        title: "Both Inactive Test",
      });

      const staleTime = new Date(Date.now() - PRESENCE_THRESHOLD_MS - 5_000).toISOString();

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

      const [attention1, attention2] = await Promise.all([attention1Promise, attention2Promise]);

      expect(attention1.shouldNotify).toBe(false);
      expect(attention2.shouldNotify).toBe(false);
      expect(sendPushSpy).toHaveBeenCalledTimes(1);
    }, 120000);
  });

  // ===========================================================================
  // EDGE CASES
  // ===========================================================================

  describe("edge cases", () => {
    test("pushes when web is stale and mobile has no heartbeat", async () => {
      client1 = await createClient(); // web
      client2 = await createClient(); // mobile - no heartbeat

      const agent = await createAgent({
        client: client1,
        title: "Mobile No Heartbeat Test",
      });

      // Web: stale
      client1.sendHeartbeat({
        deviceType: "web",
        focusedAgentId: agent.id,
        lastActivityAt: new Date(Date.now() - PRESENCE_THRESHOLD_MS - 5_000).toISOString(),
        appVisible: true,
      });

      // Mobile: never sent heartbeat (new connection)

      await new Promise((r) => setTimeout(r, 100));

      const attention1Promise = waitForAttentionRequired(client1, agent.id);
      const attention2Promise = waitForAttentionRequired(client2, agent.id);
      await client1.sendMessage(agent.id, "Say 'hello' and nothing else");

      const [attention1, attention2] = await Promise.all([attention1Promise, attention2Promise]);

      expect(attention1.shouldNotify).toBe(false);
      expect(attention2.shouldNotify).toBe(false);
      expect(sendPushSpy).toHaveBeenCalledTimes(1);
    }, 120000);

    test("notification when app not visible but activity is recent", async () => {
      client1 = await createClient();

      const agent = await createAgent({
        client: client1,
        title: "Tab Switch Test",
      });

      // User just switched tabs but was active 10 seconds ago.
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

      expect(attention.shouldNotify).toBe(true);
    }, 120000);

    test("notifies only the lower-index client when both have identical recent activity", async () => {
      client1 = await createClient(); // web
      client2 = await createClient(); // mobile

      const agent = await createAgent({
        client: client1,
        title: "Both Recent Activity Test",
      });

      const recentTime = new Date(Date.now() - 30_000).toISOString();

      // Web: tab hidden but recent activity
      client1.sendHeartbeat({
        deviceType: "web",
        focusedAgentId: null,
        lastActivityAt: recentTime,
        appVisible: false,
      });

      // Mobile: connected, also recent activity
      client2.sendHeartbeat({
        deviceType: "mobile",
        focusedAgentId: null,
        lastActivityAt: recentTime,
        appVisible: false,
      });

      await new Promise((r) => setTimeout(r, 100));

      const attention1Promise = waitForAttentionRequired(client1, agent.id);
      const attention2Promise = waitForAttentionRequired(client2, agent.id);
      await client1.sendMessage(agent.id, "Say 'hello' and nothing else");

      const [attention1, attention2] = await Promise.all([attention1Promise, attention2Promise]);

      expect(attention1.shouldNotify).toBe(true);
      expect(attention2.shouldNotify).toBe(false);
      expect(sendPushSpy).not.toHaveBeenCalled();
    }, 120000);
  });
});
