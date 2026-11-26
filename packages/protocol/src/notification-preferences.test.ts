import { describe, expect, it } from "vitest";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NotificationPreferencesSchema,
  type NotificationPreferences,
  normalizeNotificationPreferences,
  shouldDeliverNotification,
} from "./notification-preferences.js";

describe("notification-preferences", () => {
  it("defines default preferences with master, permission, error, terminalNeedsInput, and plugins on, and finished events off", () => {
    expect(DEFAULT_NOTIFICATION_PREFERENCES).toEqual({
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
    });
    expect(NotificationPreferencesSchema.parse(DEFAULT_NOTIFICATION_PREFERENCES)).toEqual(
      DEFAULT_NOTIFICATION_PREFERENCES,
    );
  });

  it("normalizes undefined, partial, and malformed preference payloads to defaults", () => {
    expect(normalizeNotificationPreferences()).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
    expect(normalizeNotificationPreferences(null)).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
    expect(normalizeNotificationPreferences("invalid")).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);

    const normalized = normalizeNotificationPreferences({
      enabled: false,
      events: {
        agentFinished: true,
        agentError: "not-a-bool",
      },
      plugins: {
        muted: ["  review-bot ", "review-bot", "", 42, "ci-watcher"],
      },
    });

    expect(normalized).toEqual({
      enabled: false,
      events: {
        agentPermission: true,
        agentError: true,
        agentFinished: true,
        terminalNeedsInput: true,
        terminalFinished: false,
      },
      plugins: {
        enabled: true,
        muted: ["ci-watcher", "review-bot"],
      },
    });
  });

  it("canonicalizes plugins.muted order so reordered arrays normalize to identical structures", () => {
    const a = normalizeNotificationPreferences({
      plugins: { muted: ["zeta", "alpha", "beta"] },
    });
    const b = normalizeNotificationPreferences({
      plugins: { muted: ["beta", "zeta", "alpha"] },
    });
    expect(a.plugins.muted).toEqual(["alpha", "beta", "zeta"]);
    expect(a).toEqual(b);
  });

  it("returns fresh cloned objects from normalizeNotificationPreferences so callers cannot mutate defaults", () => {
    const first = normalizeNotificationPreferences();
    first.events.agentFinished = true;
    first.plugins.muted.push("mutated-plugin");

    expect(DEFAULT_NOTIFICATION_PREFERENCES.events.agentFinished).toBe(false);
    expect(DEFAULT_NOTIFICATION_PREFERENCES.plugins.muted).toEqual([]);
    expect(normalizeNotificationPreferences()).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
  });

  it("delivers permission, error, terminal needs_input, and unmuted plugins under default preferences while blocking finished events", () => {
    const prefs = DEFAULT_NOTIFICATION_PREFERENCES;

    expect(shouldDeliverNotification(prefs, { kind: "agent", reason: "permission" })).toBe(true);
    expect(shouldDeliverNotification(prefs, { kind: "agent", reason: "error" })).toBe(true);
    expect(shouldDeliverNotification(prefs, { kind: "agent", reason: "finished" })).toBe(false);
    expect(shouldDeliverNotification(prefs, { kind: "terminal", reason: "needs_input" })).toBe(
      true,
    );
    expect(shouldDeliverNotification(prefs, { kind: "terminal", reason: "finished" })).toBe(false);
    expect(shouldDeliverNotification(prefs, { kind: "plugin", pluginId: "review-bot" })).toBe(true);
  });

  it("blocks every built-in event and every plugin when master enabled is false", () => {
    const prefs: NotificationPreferences = {
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

    expect(shouldDeliverNotification(prefs, { kind: "agent", reason: "permission" })).toBe(false);
    expect(shouldDeliverNotification(prefs, { kind: "agent", reason: "error" })).toBe(false);
    expect(shouldDeliverNotification(prefs, { kind: "agent", reason: "finished" })).toBe(false);
    expect(shouldDeliverNotification(prefs, { kind: "terminal", reason: "needs_input" })).toBe(
      false,
    );
    expect(shouldDeliverNotification(prefs, { kind: "terminal", reason: "finished" })).toBe(false);
    expect(shouldDeliverNotification(prefs, { kind: "plugin", pluginId: "review-bot" })).toBe(
      false,
    );
  });

  it("allows unmuted plugins when master is on and all built-in events are turned off", () => {
    const prefs: NotificationPreferences = {
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
        muted: ["noisy-plugin"],
      },
    };

    expect(shouldDeliverNotification(prefs, { kind: "agent", reason: "permission" })).toBe(false);
    expect(shouldDeliverNotification(prefs, { kind: "agent", reason: "error" })).toBe(false);
    expect(shouldDeliverNotification(prefs, { kind: "agent", reason: "finished" })).toBe(false);
    expect(shouldDeliverNotification(prefs, { kind: "terminal", reason: "needs_input" })).toBe(
      false,
    );
    expect(shouldDeliverNotification(prefs, { kind: "terminal", reason: "finished" })).toBe(false);
    expect(shouldDeliverNotification(prefs, { kind: "plugin", pluginId: "review-bot" })).toBe(true);
    expect(shouldDeliverNotification(prefs, { kind: "plugin", pluginId: "noisy-plugin" })).toBe(
      false,
    );
  });

  it("blocks all plugins when plugins.enabled is false while still respecting built-in event toggles", () => {
    const prefs: NotificationPreferences = {
      enabled: true,
      events: {
        agentPermission: true,
        agentError: false,
        agentFinished: true,
        terminalNeedsInput: false,
        terminalFinished: true,
      },
      plugins: {
        enabled: false,
        muted: [],
      },
    };

    expect(shouldDeliverNotification(prefs, { kind: "agent", reason: "permission" })).toBe(true);
    expect(shouldDeliverNotification(prefs, { kind: "agent", reason: "error" })).toBe(false);
    expect(shouldDeliverNotification(prefs, { kind: "agent", reason: "finished" })).toBe(true);
    expect(shouldDeliverNotification(prefs, { kind: "terminal", reason: "needs_input" })).toBe(
      false,
    );
    expect(shouldDeliverNotification(prefs, { kind: "terminal", reason: "finished" })).toBe(true);
    expect(shouldDeliverNotification(prefs, { kind: "plugin", pluginId: "review-bot" })).toBe(
      false,
    );
  });
});
