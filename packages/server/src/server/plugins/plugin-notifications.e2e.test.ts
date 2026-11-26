import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, test } from "vitest";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotificationPreferences,
} from "@getpaseo/protocol/notification-preferences";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { PRESENCE_THRESHOLD_MS } from "../agent-attention-policy.js";
import { resolveDaemonVersion } from "../daemon-version.js";
import { createPushNotifications, type PushPayload } from "../push/index.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeNotificationPlugin(pluginId: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `paseo-${pluginId}-`));
  roots.push(dir);
  await writeFile(
    path.join(dir, "paseo-plugin.json"),
    JSON.stringify({
      id: pluginId,
      requirements: { paseo: `>=${resolveDaemonVersion(import.meta.url)}` },
    }),
  );
  await writeFile(
    path.join(dir, "index.server.ts"),
    `import { defineRpc } from "@getpaseo/plugin";
import type {
  PluginNotificationSendInput,
  PluginServerContext,
} from "@getpaseo/plugin/server";
import { z } from "zod";

const sendRpc = defineRpc({
  name: "notify",
  input: z.unknown(),
  output: z.unknown(),
});

export default function contribute(server: PluginServerContext) {
  server.handle(sendRpc, async (input) => {
    return await server.notifications.send(input as PluginNotificationSendInput);
  });
  return () => undefined;
}
`,
  );
  return dir;
}

describe("plugin notifications E2E", () => {
  test("delivers in-app plugin.notification when client is present, suppresses when focused on target agent, and enforces dedup, rate limit, and 1024-byte data limit", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-plugin-notif-home-"));
    roots.push(home);
    const deliveries: Array<{ tokens: string[]; payload: PushPayload }> = [];
    const pushNotifications = createPushNotifications({
      logger: pino({ level: "silent" }),
      filePath: path.join(home, "push-tokens.json"),
      deliver: async (tokens, payload) => {
        deliveries.push({ tokens, payload });
      },
    });
    const daemon = await createTestPaseoDaemon({
      pushNotifications,
    });
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.18.0",
    });

    try {
      await client.connect();
      expect(client.getLastServerInfoMessage()?.features?.pluginNotifications).toBe(true);

      await client.patchDaemonConfig({ pluginsEnabled: true });
      const pluginDir = await writeNotificationPlugin("ci-alerts");
      await expect(client.installDirectoryPlugin(pluginDir)).resolves.toMatchObject({
        id: "ci-alerts",
        status: "running",
      });

      const received: Array<
        Extract<SessionOutboundMessage, { type: "plugin.notification" }>["payload"]
      > = [];
      const feed = client.observeEvents(["plugin.notification"], { notifications: true });
      feed.subscribe({
        snapshot: () => undefined,
        update: (message) => {
          if (message.type === "plugin.notification") {
            received.push(message.payload);
          }
        },
      });
      await feed.ready;

      // Client is present and looking at agent-other -> shouldNotify: true, no push
      client.sendHeartbeat({
        deviceType: "web",
        focusedAgentId: "agent-other",
        lastActivityAt: new Date().toISOString(),
        appVisible: true,
      });

      const first = (await client.invokePluginRpc("ci-alerts", "notify", {
        title: "Build failed",
        body: "Main branch check failed",
        key: "build:101",
        open: { type: "agent", agentId: "agent-target" },
        data: { buildId: 101, branch: "main" },
      })) as { status: string; notificationId?: string };

      expect(first).toEqual({
        status: "sent",
        notificationId: expect.any(String),
      });

      await expect.poll(() => received.length).toBe(1);
      expect(received[0]).toMatchObject({
        pluginId: "ci-alerts",
        notificationId: first.notificationId,
        title: "Build failed",
        body: "Main branch check failed",
        open: { type: "agent", agentId: "agent-target" },
        data: { buildId: 101, branch: "main" },
        shouldNotify: true,
      });
      expect(deliveries).toEqual([]);

      // Duplicate key within 60 s -> deduplicated, no new event emitted
      const duplicate = await client.invokePluginRpc("ci-alerts", "notify", {
        title: "Build failed again",
        body: "Same key",
        key: "build:101",
      });
      expect(duplicate).toEqual({ status: "deduplicated" });
      expect(received).toHaveLength(1);

      // Oversized data (> 1024 UTF-8 bytes) -> rejected over IPC via notification.error
      await expect(
        client.invokePluginRpc("ci-alerts", "notify", {
          title: "Oversized",
          body: "Too big",
          data: { blob: "x".repeat(1025) },
        }),
      ).rejects.toThrow("must not exceed 1024 UTF-8 bytes");

      // Present client actively focused on open.agentId -> shouldNotify: false, no push
      client.sendHeartbeat({
        deviceType: "web",
        focusedAgentId: "agent-target",
        lastActivityAt: new Date().toISOString(),
        appVisible: true,
      });

      const focusedSend = (await client.invokePluginRpc("ci-alerts", "notify", {
        title: "Agent update",
        body: "You are already watching this agent",
        open: { type: "agent", agentId: "agent-target" },
      })) as { status: string; notificationId?: string };
      expect(focusedSend.status).toBe("sent");
      await expect.poll(() => received.length).toBe(2);
      expect(received[1]).toMatchObject({
        notificationId: focusedSend.notificationId,
        shouldNotify: false,
      });

      // Consume remaining 8 tokens in the 10-token burst bucket
      for (let i = 3; i <= 10; i++) {
        await expect(
          client.invokePluginRpc("ci-alerts", "notify", {
            title: `Burst ${i}`,
            body: "Counting tokens",
          }),
        ).resolves.toMatchObject({ status: "sent" });
      }
      await expect.poll(() => received.length).toBe(10);

      // 11th notification in burst -> rate_limited
      const rateLimited = await client.invokePluginRpc("ci-alerts", "notify", {
        title: "Burst 11",
        body: "Should be rate limited",
      });
      expect(rateLimited).toEqual({ status: "rate_limited" });
      expect(received).toHaveLength(10);

      await feed.release();
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close();
    }
  }, 60_000);

  test("filters Expo push notifications per device token using two-knob preferences and per-plugin mute when away", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-plugin-push-home-"));
    roots.push(home);
    const deliveries: Array<{ tokens: string[]; payload: PushPayload }> = [];
    const pushNotifications = createPushNotifications({
      logger: pino({ level: "silent" }),
      filePath: path.join(home, "push-tokens.json"),
      deliver: async (tokens, payload) => {
        deliveries.push({ tokens, payload });
      },
    });
    const daemon = await createTestPaseoDaemon({
      pushNotifications,
    });
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.18.0",
    });

    try {
      await client.connect();
      await client.patchDaemonConfig({ pluginsEnabled: true });

      const alphaDir = await writeNotificationPlugin("plugin-alpha");
      const betaDir = await writeNotificationPlugin("plugin-beta");
      await client.installDirectoryPlugin(alphaDir);
      await client.installDirectoryPlugin(betaDir);

      // Token 1: master switch off -> blocks everything including plugins
      const masterOffPrefs: NotificationPreferences = {
        ...DEFAULT_NOTIFICATION_PREFERENCES,
        enabled: false,
      };
      client.registerPushToken("ExponentPushToken[master-off]", masterOffPrefs);

      // Token 2: master on, all built-in events off, plugins on -> allows all non-muted plugins
      const onlyPluginsPrefs: NotificationPreferences = {
        enabled: true,
        events: {
          agentPermission: false,
          agentError: false,
          agentFinished: false,
          terminalNeedsInput: false,
          terminalFinished: false,
        },
        plugins: {
          enabled: true,
          muted: [],
        },
      };
      client.registerPushToken("ExponentPushToken[only-plugins]", onlyPluginsPrefs);

      // Token 3: master on, plugins on, plugin-alpha muted -> blocks plugin-alpha, allows plugin-beta
      const mutedAlphaPrefs: NotificationPreferences = {
        ...DEFAULT_NOTIFICATION_PREFERENCES,
        plugins: {
          enabled: true,
          muted: ["plugin-alpha"],
        },
      };
      client.registerPushToken("ExponentPushToken[muted-alpha]", mutedAlphaPrefs);

      // Token 4: master on, plugins off -> blocks all plugins
      const pluginsOffPrefs: NotificationPreferences = {
        ...DEFAULT_NOTIFICATION_PREFERENCES,
        plugins: {
          enabled: false,
          muted: [],
        },
      };
      client.registerPushToken("ExponentPushToken[plugins-off]", pluginsOffPrefs);

      // Mark client stale/away so daemon sends push notifications
      const staleTime = new Date(Date.now() - PRESENCE_THRESHOLD_MS - 5_000).toISOString();
      client.sendHeartbeat({
        deviceType: "mobile",
        focusedAgentId: null,
        lastActivityAt: staleTime,
        appVisible: false,
      });

      const alphaSend = (await client.invokePluginRpc("plugin-alpha", "notify", {
        title: "Alpha alert",
        body: "From alpha",
        open: { type: "screen", screenId: "dashboard", params: { tab: "alerts" } },
        data: { source: "alpha" },
      })) as { status: string; notificationId: string };
      expect(alphaSend.status).toBe("sent");

      const betaSend = (await client.invokePluginRpc("plugin-beta", "notify", {
        title: "Beta alert",
        body: "From beta",
        open: { type: "workspace", workspaceId: "wks_123" },
        data: { source: "beta" },
      })) as { status: string; notificationId: string };
      expect(betaSend.status).toBe("sent");

      await expect.poll(() => deliveries.length).toBe(2);

      expect(deliveries[0]).toEqual({
        tokens: ["ExponentPushToken[only-plugins]"],
        payload: {
          title: "Alpha alert",
          body: "From alpha",
          data: {
            kind: "plugin",
            serverId: expect.any(String),
            pluginId: "plugin-alpha",
            notificationId: alphaSend.notificationId,
            open: { type: "screen", screenId: "dashboard", params: { tab: "alerts" } },
            data: { source: "alpha" },
          },
        },
      });

      expect(deliveries[1]).toEqual({
        tokens: ["ExponentPushToken[only-plugins]", "ExponentPushToken[muted-alpha]"],
        payload: {
          title: "Beta alert",
          body: "From beta",
          data: {
            kind: "plugin",
            serverId: expect.any(String),
            pluginId: "plugin-beta",
            notificationId: betaSend.notificationId,
            open: { type: "workspace", workspaceId: "wks_123" },
            data: { source: "beta" },
          },
        },
      });
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close();
    }
  }, 60_000);
});
