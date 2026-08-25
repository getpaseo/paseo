import { beforeEach, describe, expect, it, vi } from "vitest";
import { inAppNotificationStore } from "./in-app-notification-store";

describe("inAppNotificationStore", () => {
  beforeEach(() => {
    inAppNotificationStore.clear();
  });

  it("pushes a new notification and notifies subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = inAppNotificationStore.subscribe(listener);

    const id = inAppNotificationStore.push({
      title: "Agent completed task",
      body: "Finished in 12s",
      data: { serverId: "srv-1", agentId: "agent-1" },
    });

    expect(listener).toHaveBeenCalledTimes(1);
    const notifications = inAppNotificationStore.getNotifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.id).toBe(id);
    expect(notifications[0]?.title).toBe("Agent completed task");
    expect(notifications[0]?.body).toBe("Finished in 12s");
    expect(notifications[0]?.data).toEqual({ serverId: "srv-1", agentId: "agent-1" });

    unsubscribe();
  });

  it("keeps only the 3 most recent notifications", () => {
    inAppNotificationStore.push({ title: "Notif 1" });
    inAppNotificationStore.push({ title: "Notif 2" });
    inAppNotificationStore.push({ title: "Notif 3" });
    inAppNotificationStore.push({ title: "Notif 4" });

    const notifications = inAppNotificationStore.getNotifications();
    expect(notifications).toHaveLength(3);
    expect(notifications[0]?.title).toBe("Notif 4");
    expect(notifications[1]?.title).toBe("Notif 3");
    expect(notifications[2]?.title).toBe("Notif 2");
  });

  it("dismisses a specific notification", () => {
    const id1 = inAppNotificationStore.push({ title: "Notif 1" });
    const id2 = inAppNotificationStore.push({ title: "Notif 2" });

    inAppNotificationStore.dismiss(id1);

    const notifications = inAppNotificationStore.getNotifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.id).toBe(id2);
  });

  it("clears all notifications", () => {
    inAppNotificationStore.push({ title: "Notif 1" });
    inAppNotificationStore.push({ title: "Notif 2" });

    inAppNotificationStore.clear();

    expect(inAppNotificationStore.getNotifications()).toHaveLength(0);
  });
});
