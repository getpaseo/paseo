import { QueryClient } from "@tanstack/react-query";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotificationPreferences,
} from "@getpaseo/protocol/notification-preferences";
import { describe, expect, it } from "vitest";
import { APP_SETTINGS_QUERY_KEY, DEFAULT_CLIENT_SETTINGS } from "@/hooks/use-settings/storage";
import {
  deliverAgentAttentionOsNotification,
  deliverTerminalAttentionOsNotification,
  getCurrentNotificationPreferences,
} from "./session-notifications";

function createNotificationRecorder() {
  const sent: Array<{ title: string; body?: string; data?: Record<string, unknown> }> = [];
  return {
    sent,
    sendNotification: async (payload: {
      title: string;
      body?: string;
      data?: Record<string, unknown>;
    }) => {
      sent.push(payload);
      return true;
    },
  };
}

function makeAgentAttentionParams(reason: "permission" | "error" | "finished", index = 1) {
  return {
    agentId: `agent-${reason}-${index}`,
    reason,
    timestamp: new Date(1_700_000_000_000 + index * 1000).toISOString(),
    notification: {
      title: `Agent ${reason}`,
      body: `Body for ${reason}`,
      data: {
        serverId: "srv-1",
        workspaceId: "ws-1",
        agentId: `agent-${reason}-${index}`,
        reason,
      },
    },
  };
}

describe("session OS notification filtering", () => {
  it("normalizes notification preferences from query cache or falls back to defaults", () => {
    const emptyClient = new QueryClient();
    expect(getCurrentNotificationPreferences(emptyClient)).toEqual(
      DEFAULT_NOTIFICATION_PREFERENCES,
    );

    const populatedClient = new QueryClient();
    const custom: NotificationPreferences = {
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      events: {
        ...DEFAULT_NOTIFICATION_PREFERENCES.events,
        agentFinished: true,
      },
    };
    populatedClient.setQueryData(APP_SETTINGS_QUERY_KEY, {
      ...DEFAULT_CLIENT_SETTINGS,
      notifications: custom,
    });
    expect(getCurrentNotificationPreferences(populatedClient)).toEqual(custom);
  });

  it("with default preferences, notifies on permission, error, and terminalNeedsInput, and skips finished and terminalFinished", () => {
    const recorder = createNotificationRecorder();
    const attentionNotified = new Map<string, number>();
    const preferences = DEFAULT_NOTIFICATION_PREFERENCES;

    expect(
      deliverAgentAttentionOsNotification({
        serverId: "srv-1",
        params: makeAgentAttentionParams("permission", 1),
        isActivelyVisible: false,
        session: undefined,
        attentionNotified,
        preferences,
        sendNotification: recorder.sendNotification,
      }),
    ).toBe(true);

    expect(
      deliverAgentAttentionOsNotification({
        serverId: "srv-1",
        params: makeAgentAttentionParams("error", 2),
        isActivelyVisible: false,
        session: undefined,
        attentionNotified,
        preferences,
        sendNotification: recorder.sendNotification,
      }),
    ).toBe(true);

    expect(
      deliverAgentAttentionOsNotification({
        serverId: "srv-1",
        params: makeAgentAttentionParams("finished", 3),
        isActivelyVisible: false,
        session: undefined,
        attentionNotified,
        preferences,
        sendNotification: recorder.sendNotification,
      }),
    ).toBe(false);

    expect(
      deliverTerminalAttentionOsNotification({
        serverId: "srv-1",
        payload: {
          serverId: "srv-1",
          terminalId: "term-1",
          cwd: "/repo",
          workspaceId: "ws-1",
          reason: "needs_input",
          title: "Terminal waiting for input",
          body: "zsh",
          shouldNotify: true,
        },
        preferences,
        sendNotification: recorder.sendNotification,
      }),
    ).toBe(true);

    expect(
      deliverTerminalAttentionOsNotification({
        serverId: "srv-1",
        payload: {
          serverId: "srv-1",
          terminalId: "term-1",
          cwd: "/repo",
          workspaceId: "ws-1",
          reason: "finished",
          title: "Command finished",
          body: "zsh",
          shouldNotify: true,
        },
        preferences,
        sendNotification: recorder.sendNotification,
      }),
    ).toBe(false);

    expect(recorder.sent.map((item) => item.title)).toEqual([
      "Agent permission",
      "Agent error",
      "Terminal waiting for input",
    ]);
  });

  it("delivers finished notifications when agentFinished and terminalFinished are enabled", () => {
    const recorder = createNotificationRecorder();
    const attentionNotified = new Map<string, number>();
    const preferences: NotificationPreferences = {
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      events: {
        ...DEFAULT_NOTIFICATION_PREFERENCES.events,
        agentFinished: true,
        terminalFinished: true,
      },
    };

    expect(
      deliverAgentAttentionOsNotification({
        serverId: "srv-1",
        params: makeAgentAttentionParams("finished", 1),
        isActivelyVisible: false,
        session: undefined,
        attentionNotified,
        preferences,
        sendNotification: recorder.sendNotification,
      }),
    ).toBe(true);

    expect(
      deliverTerminalAttentionOsNotification({
        serverId: "srv-1",
        payload: {
          serverId: "srv-1",
          terminalId: "term-1",
          cwd: "/repo",
          workspaceId: "ws-1",
          reason: "finished",
          title: "Command finished",
          body: "zsh",
          shouldNotify: true,
        },
        preferences,
        sendNotification: recorder.sendNotification,
      }),
    ).toBe(true);

    expect(recorder.sent.map((item) => item.title)).toEqual(["Agent finished", "Command finished"]);
  });

  it("blocks all agent and terminal notifications when master enabled is false", () => {
    const recorder = createNotificationRecorder();
    const attentionNotified = new Map<string, number>();
    const preferences: NotificationPreferences = {
      enabled: false,
      events: {
        agentPermission: true,
        agentError: true,
        agentFinished: true,
        terminalNeedsInput: true,
        terminalFinished: true,
      },
      plugins: {
        enabled: true,
        muted: [],
      },
    };

    for (const reason of ["permission", "error", "finished"] as const) {
      expect(
        deliverAgentAttentionOsNotification({
          serverId: "srv-1",
          params: makeAgentAttentionParams(reason),
          isActivelyVisible: false,
          session: undefined,
          attentionNotified,
          preferences,
          sendNotification: recorder.sendNotification,
        }),
      ).toBe(false);
    }

    for (const reason of ["needs_input", "finished"] as const) {
      expect(
        deliverTerminalAttentionOsNotification({
          serverId: "srv-1",
          payload: {
            serverId: "srv-1",
            terminalId: "term-1",
            cwd: "/repo",
            workspaceId: "ws-1",
            reason,
            title: `Terminal ${reason}`,
            body: "zsh",
            shouldNotify: true,
          },
          preferences,
          sendNotification: recorder.sendNotification,
        }),
      ).toBe(false);
    }

    expect(recorder.sent).toEqual([]);
  });
});
