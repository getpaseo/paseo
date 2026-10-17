import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { DaemonClient } from "./test-utils/daemon-client.js";
import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import type { AgentSnapshotPayload } from "./messages.js";
import type { PushNotificationSender, PushPayload } from "./push/index.js";
import { PRESENCE_THRESHOLD_MS } from "./agent-attention-policy.js";
import { AGENT_NOTIFICATIONS_MUTED_LABEL } from "@getpaseo/protocol/agent-labels";
import { dirname } from "node:path";

class RecordingPushNotificationSender implements PushNotificationSender {
  readonly sent: PushPayload[] = [];

  async send(payload: PushPayload): Promise<void> {
    this.sent.push(payload);
  }
}

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
  let daemon: TestPaseoDaemon;
  let client1: DaemonClient;
  let client2: DaemonClient;
  let pushNotifications: RecordingPushNotificationSender;

  beforeEach(async () => {
    pushNotifications = new RecordingPushNotificationSender();
    daemon = await createTestPaseoDaemon({ pushNotificationSender: pushNotifications });
  });

  afterEach(async () => {
    if (client1) await client1.close().catch(() => {});
    if (client2) await client2.close().catch(() => {});
    await daemon.close();
  }, 30000);

  async function createClient(): Promise<DaemonClient> {
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      messageQueueLimit: null,
    });
    await client.connect();
    await client.observeEvents(["agent_attention_required"], { notifications: true }).ready;
    return client;
  }

  async function createAgent(params: {
    client: DaemonClient;
    title: string;
  }): Promise<AgentSnapshotPayload> {
    const { workspace, error } = await params.client.createWorkspace({
      source: { kind: "directory", path: daemon.paseoHome },
    });
    if (!workspace) throw new Error(error ?? "Expected activity test workspace");
    return params.client.createAgent({
      provider: TEST_PROVIDER,
      model: TEST_MODEL,
      cwd: daemon.paseoHome,
      workspaceId: workspace.id,
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

      const cleanup = client.onAgentAttentionRequired((notification) => {
        if (notification.agentId !== agentId) return;
        clearTimeout(timer);
        cleanup();
        resolve({ type: "attention_required", ...notification });
      });
    });
  }

  function waitForAssistantTimeline(
    client: DaemonClient,
    agentId: string,
    timeout = 60000,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout waiting for assistant timeline (${timeout}ms)`));
      }, timeout);

      const cleanup = client.subscribeAgentTimeline(agentId, (msg) => {
        if (msg.type !== "agent_stream") return;
        if (msg.payload.agentId !== agentId) return;
        if (msg.payload.event.type !== "timeline") return;
        const item = msg.payload.event.item;
        if (item.type !== "assistant_message") return;

        clearTimeout(timer);
        cleanup();
        resolve(item.text);
      });
    });
  }

  // ===========================================================================
  // SINGLE CLIENT SCENARIOS
  // ===========================================================================

  test("muting an agent suppresses alerts while preserving its unread completion", async () => {
    client1 = await createClient();
    expect(client1.getLastServerInfoMessage()?.features?.agentNotificationMute).toBe(true);
    const agent = await createAgent({ client: client1, title: "Muted completion" });
    await client1.updateAgent(agent.id, {
      labels: { [AGENT_NOTIFICATIONS_MUTED_LABEL]: "true" },
    });
    client1.sendHeartbeat({
      deviceType: "web",
      focusedAgentId: null,
      lastActivityAt: new Date().toISOString(),
      appVisible: false,
    });
    await client1.ping();

    const attentionPromise = waitForAttentionRequired(client1, agent.id);
    await client1.sendMessage(agent.id, "Say 'hello' and nothing else");
    const attention = await attentionPromise;

    expect(attention.reason).toBe("finished");
    expect(attention.shouldNotify).toBe(false);
    expect(pushNotifications.sent).toEqual([]);
    expect((await client1.fetchAgent({ agentId: agent.id }))?.agent).toMatchObject({
      status: "idle",
      requiresAttention: true,
      attentionReason: "finished",
      labels: {
        surface: "activity-test",
        [AGENT_NOTIFICATIONS_MUTED_LABEL]: "true",
      },
    });

    const unmutedAgent = await createAgent({ client: client1, title: "Unmuted neighbor" });
    const unmutedAttention = waitForAttentionRequired(client1, unmutedAgent.id);
    await client1.sendMessage(unmutedAgent.id, "Say 'hello' and nothing else");
    expect((await unmutedAttention).shouldNotify).toBe(true);
    expect(pushNotifications.sent).toEqual([]);
  });

  test("muting survives reload and daemon restart, and unmuting restores push alerts", async () => {
    client1 = await createClient();
    const agent = await createAgent({ client: client1, title: "Persistent mute" });
    await client1.updateAgent(agent.id, {
      labels: { [AGENT_NOTIFICATIONS_MUTED_LABEL]: "true" },
    });
    await client1.refreshAgent(agent.id);
    expect((await client1.fetchAgent({ agentId: agent.id }))?.agent.labels).toMatchObject({
      [AGENT_NOTIFICATIONS_MUTED_LABEL]: "true",
    });

    const paseoHomeRoot = dirname(daemon.paseoHome);
    const staticDir = daemon.staticDir;
    await client1.close();
    await daemon.daemon.stop();
    await daemon.daemon.agentManager.flush();
    daemon = await createTestPaseoDaemon({
      paseoHomeRoot,
      staticDir,
      pushNotificationSender: pushNotifications,
    });
    client1 = await createClient();
    expect((await client1.fetchAgent({ agentId: agent.id }))?.agent.labels).toMatchObject({
      surface: "activity-test",
      [AGENT_NOTIFICATIONS_MUTED_LABEL]: "true",
    });

    client2 = await createClient();
    const siblingUpdates: AgentSnapshotPayload[] = [];
    client2.on("agent_update", (message) => {
      if (message.payload.kind === "upsert") siblingUpdates.push(message.payload.agent);
    });
    await client2.observeAgents().ready;
    await client1.updateAgent(agent.id, {
      labels: { [AGENT_NOTIFICATIONS_MUTED_LABEL]: "false" },
    });
    await expect
      .poll(() => siblingUpdates)
      .toContainEqual(
        expect.objectContaining({
          id: agent.id,
          status: "closed",
          labels: expect.objectContaining({ [AGENT_NOTIFICATIONS_MUTED_LABEL]: "false" }),
        }),
      );
    await client1.updateAgent(agent.id, {
      labels: { [AGENT_NOTIFICATIONS_MUTED_LABEL]: "true" },
    });
    await expect
      .poll(() => siblingUpdates)
      .toContainEqual(
        expect.objectContaining({
          id: agent.id,
          labels: expect.objectContaining({ [AGENT_NOTIFICATIONS_MUTED_LABEL]: "true" }),
        }),
      );

    const mutedAttention = waitForAttentionRequired(client1, agent.id);
    await client1.sendMessage(agent.id, "Say 'hello' and nothing else");
    expect((await mutedAttention).shouldNotify).toBe(false);
    expect(pushNotifications.sent).toEqual([]);

    await client1.clearAgentAttention(agent.id);
    await client1.updateAgent(agent.id, {
      labels: { [AGENT_NOTIFICATIONS_MUTED_LABEL]: "false" },
    });
    const unmutedAttention = waitForAttentionRequired(client1, agent.id);
    await client1.sendMessage(agent.id, "Say 'hello again' and nothing else");
    expect((await unmutedAttention).reason).toBe("finished");
    expect(pushNotifications.sent).toHaveLength(1);
    expect(pushNotifications.sent[0]?.data).toMatchObject({
      agentId: agent.id,
      reason: "finished",
    });
    expect((await client1.fetchAgent({ agentId: agent.id }))?.agent.labels).toMatchObject({
      surface: "activity-test",
      [AGENT_NOTIFICATIONS_MUTED_LABEL]: "false",
    });
  });

  test("muted agents retain normal error alerts for a present client", async () => {
    client1 = await createClient();
    const agent = await createAgent({ client: client1, title: "Muted error" });
    await client1.updateAgent(agent.id, { labels: { [AGENT_NOTIFICATIONS_MUTED_LABEL]: "true" } });
    client1.sendHeartbeat({
      deviceType: "mobile",
      focusedAgentId: null,
      lastActivityAt: new Date().toISOString(),
      appVisible: false,
    });
    await client1.ping();
    const attentionPromise = waitForAttentionRequired(client1, agent.id);
    await client1.sendMessage(agent.id, "Emit a turn failure");
    const attention = await attentionPromise;

    expect(attention.reason).toBe("error");
    expect(attention.shouldNotify).toBe(true);
    expect(pushNotifications.sent).toEqual([]);
    expect((await client1.fetchAgent({ agentId: agent.id }))?.agent).toMatchObject({
      status: "error",
      requiresAttention: true,
      attentionReason: "error",
      lastError: "Requested fake provider failure",
    });
  });

  test("muted agents still push permission alerts and keep completion alerts quiet", async () => {
    client1 = await createClient();
    const agent = await createAgent({ client: client1, title: "Muted permission" });
    await client1.updateAgent(agent.id, { labels: { [AGENT_NOTIFICATIONS_MUTED_LABEL]: "true" } });
    const attentionPromise = waitForAttentionRequired(client1, agent.id);
    await client1.sendMessage(agent.id, "Run rm -f permission.txt");
    const attention = await attentionPromise;

    expect(attention.reason).toBe("permission");
    expect(attention.shouldNotify).toBe(false);
    expect(pushNotifications.sent).toHaveLength(1);
    expect(pushNotifications.sent[0]?.data).toMatchObject({
      agentId: agent.id,
      reason: "permission",
    });
    const snapshot = (await client1.fetchAgent({ agentId: agent.id }))?.agent;
    expect(snapshot?.status).toBe("running");
    expect(snapshot?.pendingPermissions).toHaveLength(1);
    const permission = snapshot?.pendingPermissions[0];
    if (!permission) throw new Error("Expected pending permission request");
    const completionPromise = waitForAttentionRequired(client1, agent.id);
    await client1.respondToPermission(agent.id, permission.id, { behavior: "allow" });
    const completion = await completionPromise;
    expect(completion.reason).toBe("finished");
    expect(completion.shouldNotify).toBe(false);
    expect(pushNotifications.sent).toHaveLength(1);
    expect((await client1.fetchAgent({ agentId: agent.id }))?.agent).toMatchObject({
      status: "idle",
      pendingPermissions: [],
      requiresAttention: true,
      attentionReason: "finished",
    });
  });

  test("muted agents still notify a present client about permission requests", async () => {
    client1 = await createClient();
    const agent = await createAgent({ client: client1, title: "Muted in-app permission" });
    await client1.updateAgent(agent.id, { labels: { [AGENT_NOTIFICATIONS_MUTED_LABEL]: "true" } });
    client1.sendHeartbeat({
      deviceType: "web",
      focusedAgentId: null,
      lastActivityAt: new Date().toISOString(),
      appVisible: true,
    });
    await client1.ping();
    const attentionPromise = waitForAttentionRequired(client1, agent.id);
    await client1.sendMessage(agent.id, "Run rm -f permission.txt");
    const attention = await attentionPromise;

    expect(attention.reason).toBe("permission");
    expect(attention.shouldNotify).toBe(true);
    expect(pushNotifications.sent).toEqual([]);
    const snapshot = (await client1.fetchAgent({ agentId: agent.id }))?.agent;
    const permission = snapshot?.pendingPermissions[0];
    if (!permission) throw new Error("Expected pending permission request");
    const completionPromise = waitForAttentionRequired(client1, agent.id);
    await client1.respondToPermission(agent.id, permission.id, { behavior: "allow" });
    const completion = await completionPromise;
    expect(completion.reason).toBe("finished");
    expect(completion.shouldNotify).toBe(false);
    expect(pushNotifications.sent).toEqual([]);
    expect((await client1.fetchAgent({ agentId: agent.id }))?.agent.pendingPermissions).toEqual([]);
  });

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
      expect(pushNotifications.sent).toHaveLength(1);
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
      expect(pushNotifications.sent).toHaveLength(1);
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
      expect(pushNotifications.sent).toHaveLength(1);
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
      expect(pushNotifications.sent).toEqual([]);
    }, 120000);
  });

  // ===========================================================================
  // WEB + MOBILE - DEVICE PRIORITY SCENARIOS
  // ===========================================================================

  describe("web and mobile clients", () => {
    test("mobile stream delivery does not depend on heartbeat focus", async () => {
      client1 = await createClient(); // web
      client2 = await createClient(); // mobile

      const agent = await createAgent({
        client: client1,
        title: "Mobile Stale Focus Stream Test",
      });

      client2.sendHeartbeat({
        deviceType: "mobile",
        focusedAgentId: null,
        lastActivityAt: new Date(Date.now() - PRESENCE_THRESHOLD_MS - 60_000).toISOString(),
        appVisible: false,
        appVisibilityChangedAt: new Date(Date.now() - 120_000).toISOString(),
      });

      await new Promise((r) => setTimeout(r, 100));

      const mobileStream = waitForAssistantTimeline(client2, agent.id);
      await client1.sendMessage(agent.id, "Say 'hello' and nothing else");

      await expect(mobileStream).resolves.toMatch(/hello/i);
    }, 120000);

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
      expect(pushNotifications.sent).toEqual([]);
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
      expect(pushNotifications.sent).toHaveLength(1);
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
      expect(pushNotifications.sent).toHaveLength(1);
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
      expect(pushNotifications.sent).toEqual([]);
    }, 120000);
  });
});
