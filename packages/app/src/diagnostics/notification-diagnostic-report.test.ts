import { describe, expect, test } from "vitest";
import {
  collectNotificationDiagnosticSection,
  formatNotificationDiagnosticSection,
  type NotificationDiagnosticEnvironment,
} from "./notification-diagnostic-report";

function fakeEnvironment(
  overrides: Partial<NotificationDiagnosticEnvironment> = {},
): NotificationDiagnosticEnvironment {
  return {
    isWeb: true,
    isNative: false,
    hasDesktopBridge: () => false,
    getNotificationPermission: () => "granted",
    hasServiceWorker: () => true,
    ...overrides,
  };
}

describe("notification diagnostic report", () => {
  test("formats browser notification status", () => {
    const report = collectNotificationDiagnosticSection(fakeEnvironment());

    expect(report).toContain("Notifications");
    expect(report).toContain("Web runtime: yes");
    expect(report).toContain("Native runtime: no");
    expect(report).toContain("Desktop bridge: unavailable");
    expect(report).toContain("Notification API: available");
    expect(report).toContain("Permission: granted");
    expect(report).toContain("Service Worker: available");
  });

  test("marks missing Notification API as unavailable", () => {
    const report = formatNotificationDiagnosticSection({
      isWeb: true,
      isNative: false,
      desktopBridge: "unavailable",
      notificationApi: "unavailable",
      permission: "unavailable",
      serviceWorker: "unavailable",
    });

    expect(report).toContain("Notification API: unavailable");
    expect(report).toContain("Permission: unavailable");
    expect(report).toContain("Service Worker: unavailable");
  });

  test("reports desktop bridge availability", () => {
    const report = collectNotificationDiagnosticSection(
      fakeEnvironment({
        hasDesktopBridge: () => true,
        getNotificationPermission: () => "default",
        hasServiceWorker: () => false,
      }),
    );

    expect(report).toContain("Desktop bridge: available");
    expect(report).toContain("Permission: default");
    expect(report).toContain("Service Worker: unavailable");
  });
});
