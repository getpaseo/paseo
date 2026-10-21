import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NotificationDispatcher, type NotificationEvent } from "./notification-dispatcher.js";
import { resolveNotificationConfig } from "./notification-config.js";
import { createNotificationHttpFake, createNotificationTestLogger } from "./test-utils.js";
import type { PushPayload } from "../push/index.js";
import type { ClientPresenceState } from "../agent-attention-policy.js";

describe("notification dispatcher", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });
  const ntfyEnv = {
    PASEO_NOTIFICATION_PROVIDER: "both",
    PASEO_NOTIFICATION_MODE: "always_push",
    PASEO_NTFY_URL: "https://ntfy.example.com",
    PASEO_NTFY_TOPIC: "agents",
    PASEO_NTFY_TOKEN: "private-bearer",
  };
  const event: NotificationEvent = {
    id: "server:agent:finished:1",
    type: "agent_finished",
    timestamp: "2026-10-14T12:00:00Z",
    payload: {
      title: "Agent finished",
      body: "private-preview",
      data: { serverId: "server", workspaceId: "worktree", agentId: "agent" },
    },
    agentName: "کدکس",
    provider: "codex",
    workspaceName: "worktree",
    projectName: "project",
  };
  const focusTarget = { kind: "agent" as const, id: "agent" };
  const desktop: ClientPresenceState = {
    deviceType: "web",
    appVisible: true,
    lastActivityAtMs: 1000,
    focusedAgentId: "agent",
    focusedTerminalId: null,
    lastHeartbeatAtMs: 1000,
  };

  function create(
    env = ntfyEnv,
    responses: Parameters<typeof createNotificationHttpFake>[0] = [
      { body: { id: "message", event: "message" } },
    ],
    failExpo = false,
  ) {
    const home = mkdtempSync(join(tmpdir(), "paseo-router-"));
    homes.push(home);
    const fake = createNotificationHttpFake(responses);
    const sent: PushPayload[] = [];
    const { logger, records } = createNotificationTestLogger();
    const dispatcher = new NotificationDispatcher({
      config: resolveNotificationConfig(env),
      logger,
      filePath: join(home, "ntfy.json"),
      http: fake.request,
      now: () => 1000,
      automatic: false,
      expo: {
        send: async (payload) => {
          if (failExpo) throw new Error("expo failed");
          sent.push(payload);
        },
      },
    });
    return { dispatcher, fake, sent, records };
  }
  it("sends to both providers despite focused desktop presence, with safe UTF-8 ntfy payload", async () => {
    const { dispatcher, fake, sent, records } = create();
    dispatcher.dispatch(event, [desktop], focusTarget);
    await dispatcher.flush();
    expect(sent).toHaveLength(1);
    const message = JSON.parse(fake.requests[0].init.body as string);
    expect(message).toMatchObject({ topic: "agents", priority: 3, title: "کدکس - Agent finished" });
    expect(message.message).toContain("Project: project");
    expect(message.message).toContain("Server: server");
    expect(message.message).not.toContain("private-preview");
    expect(sent[0].body).toBe("Finished working.");
    expect(fake.requests[0].init.headers).toMatchObject({ Authorization: "Bearer private-bearer" });
    expect(records.join("\n")).not.toContain("private-bearer");
    await dispatcher.close();
  });
  it("ntfy succeeds independently when Expo fails or has no devices", async () => {
    const { dispatcher, fake, records } = create(ntfyEnv, undefined, true);
    dispatcher.dispatch(event, [desktop], focusTarget);
    await dispatcher.flush();
    expect(fake.requests).toHaveLength(1);
    expect(records.join("\n")).toContain("ntfy notification accepted");
    await dispatcher.close();
    const ntfy = create({ ...ntfyEnv, PASEO_NOTIFICATION_PROVIDER: "ntfy" });
    ntfy.dispatcher.dispatch(event, [], focusTarget);
    await ntfy.dispatcher.flush();
    expect(ntfy.sent).toEqual([]);
    expect(ntfy.fake.requests).toHaveLength(1);
    await ntfy.dispatcher.close();
  });
  it("ntfy delivery bypasses legacy desktop suppression", async () => {
    const { dispatcher, fake, sent } = create({ ...ntfyEnv, PASEO_NOTIFICATION_MODE: "legacy" });
    dispatcher.dispatch(event, [desktop], focusTarget);
    await dispatcher.flush();
    expect(sent).toEqual([]);
    expect(fake.requests).toHaveLength(1);
    await dispatcher.close();
  });
  it.each([
    "agent_finished",
    "agent_error",
    "permission_required",
    "terminal_finished",
    "terminal_attention",
  ] as const)("delivers %s with matching identity and priority", async (type) => {
    const { dispatcher, fake, sent } = create();
    dispatcher.dispatch({ ...event, type }, [], focusTarget);
    await dispatcher.flush();
    expect(sent[0].data).toMatchObject({
      serverId: "server",
      workspaceId: "worktree",
      agentId: "agent",
      notificationId: event.id,
    });
    expect(JSON.parse(fake.requests[0].init.body as string).priority).toBe(
      {
        agent_finished: 3,
        agent_error: 4,
        permission_required: 5,
        terminal_finished: 3,
        terminal_attention: 3,
      }[type],
    );
    await dispatcher.close();
  });
  it("honors per-event and global disabling without network requests", async () => {
    for (const settings of [
      { PASEO_NOTIFICATIONS_ENABLED: "false" },
      { PASEO_NOTIFY_ON_FINISH: "false" },
    ]) {
      const { dispatcher, fake, sent } = create({ ...ntfyEnv, ...settings });
      dispatcher.dispatch(event, [], focusTarget);
      await dispatcher.flush();
      expect(fake.requests).toEqual([]);
      expect(sent).toEqual([]);
      await dispatcher.close();
    }
  });
  it("smart suppresses only a fresh, visible, same-agent phone", async () => {
    const { dispatcher, sent } = create({
      ...ntfyEnv,
      PASEO_NOTIFICATION_MODE: "smart",
      PASEO_NOTIFICATION_PROVIDER: "expo",
    });
    dispatcher.dispatch(
      event,
      [desktop, { ...desktop, deviceType: "mobile", pushToken: "viewing-phone" }],
      focusTarget,
    );
    expect(sent[0].excludedTokens).toEqual(["viewing-phone"]);
    await dispatcher.close();
  });
  it("enables assistant previews only by explicit opt-in and bounds their length", async () => {
    const { dispatcher, sent } = create({
      ...ntfyEnv,
      PASEO_NOTIFICATION_PROVIDER: "expo",
      PASEO_NOTIFICATION_PREVIEWS: "true",
    });
    dispatcher.dispatch(
      { ...event, payload: { ...event.payload, body: "a".repeat(300) } },
      [],
      focusTarget,
    );
    expect(sent[0].body).toBe("a".repeat(220));
    await dispatcher.close();
  });

  it("deduplicates only identical event IDs", async () => {
    const { dispatcher, sent } = create({ ...ntfyEnv, PASEO_NOTIFICATION_PROVIDER: "expo" });
    dispatcher.dispatch(event, [], focusTarget);
    dispatcher.dispatch(event, [], focusTarget);
    dispatcher.dispatch(
      {
        ...event,
        id: "server:other-agent:finished:1",
        payload: { ...event.payload, data: { agentId: "other-agent" } },
      },
      [],
      focusTarget,
    );
    expect(sent.map((payload) => payload.data?.notificationId)).toEqual([
      event.id,
      "server:other-agent:finished:1",
    ]);
    await dispatcher.close();
  });
});
