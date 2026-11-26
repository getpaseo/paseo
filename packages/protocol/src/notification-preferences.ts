import { z } from "zod";

export interface NotificationPreferences {
  enabled: boolean;
  events: {
    agentPermission: boolean;
    agentError: boolean;
    agentFinished: boolean;
    terminalNeedsInput: boolean;
    terminalFinished: boolean;
  };
  plugins: {
    enabled: boolean;
    muted: string[];
  };
}

export const NotificationEventsPreferencesSchema = z.object({
  agentPermission: z.boolean().optional(),
  agentError: z.boolean().optional(),
  agentFinished: z.boolean().optional(),
  terminalNeedsInput: z.boolean().optional(),
  terminalFinished: z.boolean().optional(),
});

export const NotificationPluginsPreferencesSchema = z.object({
  enabled: z.boolean().optional(),
  muted: z.array(z.string()).optional(),
});

export const NotificationPreferencesSchema = z.object({
  enabled: z.boolean().optional(),
  events: NotificationEventsPreferencesSchema.optional(),
  plugins: NotificationPluginsPreferencesSchema.optional(),
});

export type NotificationPreferencesInput = z.infer<typeof NotificationPreferencesSchema>;

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  enabled: true,
  events: {
    agentPermission: true,
    agentError: true,
    agentFinished: false,
    terminalNeedsInput: true,
    terminalFinished: false,
  },
  plugins: {
    enabled: true,
    muted: [],
  },
};

export type NotificationKind =
  | { kind: "agent"; reason: "permission" | "error" | "finished" }
  | { kind: "terminal"; reason: "needs_input" | "finished" }
  | { kind: "plugin"; pluginId: string };

export function normalizeNotificationPreferences(raw?: unknown): NotificationPreferences {
  if (!raw || typeof raw !== "object") {
    return {
      enabled: DEFAULT_NOTIFICATION_PREFERENCES.enabled,
      events: { ...DEFAULT_NOTIFICATION_PREFERENCES.events },
      plugins: {
        enabled: DEFAULT_NOTIFICATION_PREFERENCES.plugins.enabled,
        muted: [...DEFAULT_NOTIFICATION_PREFERENCES.plugins.muted],
      },
    };
  }

  const candidate = raw as {
    enabled?: unknown;
    events?: unknown;
    plugins?: unknown;
  };
  const eventsCandidate =
    candidate.events && typeof candidate.events === "object"
      ? (candidate.events as Record<string, unknown>)
      : {};
  const pluginsCandidate =
    candidate.plugins && typeof candidate.plugins === "object"
      ? (candidate.plugins as { enabled?: unknown; muted?: unknown })
      : {};

  const muted = Array.isArray(pluginsCandidate.muted)
    ? Array.from(
        new Set(
          pluginsCandidate.muted
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter((item) => item.length > 0),
        ),
      ).sort()
    : [...DEFAULT_NOTIFICATION_PREFERENCES.plugins.muted];

  return {
    enabled:
      typeof candidate.enabled === "boolean"
        ? candidate.enabled
        : DEFAULT_NOTIFICATION_PREFERENCES.enabled,
    events: {
      agentPermission:
        typeof eventsCandidate.agentPermission === "boolean"
          ? eventsCandidate.agentPermission
          : DEFAULT_NOTIFICATION_PREFERENCES.events.agentPermission,
      agentError:
        typeof eventsCandidate.agentError === "boolean"
          ? eventsCandidate.agentError
          : DEFAULT_NOTIFICATION_PREFERENCES.events.agentError,
      agentFinished:
        typeof eventsCandidate.agentFinished === "boolean"
          ? eventsCandidate.agentFinished
          : DEFAULT_NOTIFICATION_PREFERENCES.events.agentFinished,
      terminalNeedsInput:
        typeof eventsCandidate.terminalNeedsInput === "boolean"
          ? eventsCandidate.terminalNeedsInput
          : DEFAULT_NOTIFICATION_PREFERENCES.events.terminalNeedsInput,
      terminalFinished:
        typeof eventsCandidate.terminalFinished === "boolean"
          ? eventsCandidate.terminalFinished
          : DEFAULT_NOTIFICATION_PREFERENCES.events.terminalFinished,
    },
    plugins: {
      enabled:
        typeof pluginsCandidate.enabled === "boolean"
          ? pluginsCandidate.enabled
          : DEFAULT_NOTIFICATION_PREFERENCES.plugins.enabled,
      muted,
    },
  };
}

export function shouldDeliverNotification(
  prefs: NotificationPreferences,
  target: NotificationKind,
): boolean {
  if (!prefs.enabled) {
    return false;
  }

  switch (target.kind) {
    case "agent":
      switch (target.reason) {
        case "permission":
          return prefs.events.agentPermission;
        case "error":
          return prefs.events.agentError;
        case "finished":
          return prefs.events.agentFinished;
      }
      break;
    case "terminal":
      switch (target.reason) {
        case "needs_input":
          return prefs.events.terminalNeedsInput;
        case "finished":
          return prefs.events.terminalFinished;
      }
      break;
    case "plugin":
      if (!prefs.plugins.enabled) {
        return false;
      }
      return !prefs.plugins.muted.includes(target.pluginId);
  }
}
