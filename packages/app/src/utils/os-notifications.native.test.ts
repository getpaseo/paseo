import { beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  channel: vi.fn(),
  permissions: vi.fn(),
  request: vi.fn(),
  schedule: vi.fn(),
}));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("expo-notifications", () => ({
  setNotificationChannelAsync: mocks.channel,
  getPermissionsAsync: mocks.permissions,
  requestPermissionsAsync: mocks.request,
  scheduleNotificationAsync: mocks.schedule,
  AndroidImportance: { DEFAULT: 3 },
}));
import { sendOsNotification } from "./os-notifications.native";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.channel.mockResolvedValue(undefined);
  mocks.schedule.mockResolvedValue("notification-id");
});
test("shows a local task notification without requiring a push token and preserves its click target", async () => {
  mocks.permissions.mockResolvedValue({ granted: true, canAskAgain: true });
  expect(
    await sendOsNotification({ title: "Completed", data: { serverId: "host", agentId: "task" } }),
  ).toBe(true);
  expect(mocks.schedule).toHaveBeenCalledWith({
    content: {
      title: "Completed",
      body: undefined,
      data: { serverId: "host", agentId: "task", paseoLocalNotification: true },
    },
    trigger: null,
  });
  expect(mocks.request).not.toHaveBeenCalled();
});
test("requests Android notification permission when allowed", async () => {
  mocks.permissions.mockResolvedValue({ granted: false, canAskAgain: true });
  mocks.request.mockResolvedValue({ granted: true });
  expect(await sendOsNotification({ title: "Completed" })).toBe(true);
  expect(mocks.channel.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.request.mock.invocationCallOrder[0],
  );
});
test("does not schedule a notification when permission cannot be requested", async () => {
  mocks.permissions.mockResolvedValue({ granted: false, canAskAgain: false });
  expect(await sendOsNotification({ title: "Completed" })).toBe(false);
  expect(mocks.request).not.toHaveBeenCalled();
  expect(mocks.schedule).not.toHaveBeenCalled();
});
