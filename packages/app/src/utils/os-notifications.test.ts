import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface MockNotificationOptions {
  body?: string;
  data?: Record<string, unknown>;
  icon?: string;
}

interface MockNotificationInstance {
  title: string;
  options?: MockNotificationOptions;
  clickListeners: Array<(event: Event) => void>;
  addEventListener: (event: string, listener: (event: Event) => void) => void;
  close: ReturnType<typeof vi.fn>;
}

interface GlobalSnapshot {
  Notification: unknown;
  CustomEvent: unknown;
  dispatchEvent: unknown;
  focus: unknown;
  location: unknown;
}

const originalGlobals: GlobalSnapshot = {
  Notification: (globalThis as { Notification?: unknown }).Notification,
  CustomEvent: (globalThis as { CustomEvent?: unknown }).CustomEvent,
  dispatchEvent: (globalThis as { dispatchEvent?: unknown }).dispatchEvent,
  focus: (globalThis as { focus?: unknown }).focus,
  location: (globalThis as { location?: unknown }).location,
};

async function loadModuleForPlatform(
  platform: "web" | "ios" | "android",
  options?: {
    desktopHost?: {
      notification?: {
        sendNotification?: (payload: {
          title: string;
          body?: string;
          data?: Record<string, unknown>;
        }) => Promise<boolean>;
      };
    } | null;
  },
) {
  vi.resetModules();
  vi.doMock("react-native", () => ({ Platform: { OS: platform } }));
  vi.doMock("@/desktop/host", () => ({
    getDesktopHost: () => options?.desktopHost ?? null,
  }));
  vi.doMock("expo-asset", () => ({
    Asset: {
      fromModule: vi.fn(() => ({
        uri: "http://localhost:8081/packages/app/assets/images/notification-icon.png",
      })),
    },
  }));
  return import("./os-notifications");
}

function restoreGlobals(): void {
  (globalThis as { Notification?: unknown }).Notification = originalGlobals.Notification;
  (globalThis as { CustomEvent?: unknown }).CustomEvent = originalGlobals.CustomEvent;
  (globalThis as { dispatchEvent?: unknown }).dispatchEvent = originalGlobals.dispatchEvent;
  (globalThis as { focus?: unknown }).focus = originalGlobals.focus;
  (globalThis as { location?: unknown }).location = originalGlobals.location;
}

describe("sendOsNotification", () => {
  beforeEach(() => {
    class MockCustomEvent<T = unknown> {
      type: string;
      detail: T;
      cancelable: boolean;
      defaultPrevented = false;

      constructor(type: string, init?: { detail?: T; cancelable?: boolean }) {
        this.type = type;
        this.detail = (init?.detail ?? null) as T;
        this.cancelable = init?.cancelable ?? false;
      }

      preventDefault(): void {
        if (this.cancelable) {
          this.defaultPrevented = true;
        }
      }
    }

    (globalThis as { CustomEvent?: unknown }).CustomEvent = MockCustomEvent;
    (globalThis as { focus?: unknown }).focus = vi.fn();
  });

  afterEach(() => {
    vi.doUnmock("react-native");
    vi.restoreAllMocks();
    vi.resetModules();
    restoreGlobals();
  });

  it("dispatches a click event that the app can handle", async () => {
    const created: MockNotificationInstance[] = [];

    class MockNotification implements MockNotificationInstance {
      static permission = "granted";
      static requestPermission = vi.fn(async () => "granted");
      clickListeners: Array<(event: Event) => void> = [];
      close = vi.fn();

      constructor(
        public title: string,
        public options?: MockNotificationOptions,
      ) {
        created.push(this);
      }

      addEventListener(event: string, listener: (event: Event) => void): void {
        if (event === "click") {
          this.clickListeners.push(listener);
        }
      }
    }

    const dispatchEvent = vi.fn((event: unknown) => {
      void event;
      return false;
    });
    const assign = vi.fn();

    (globalThis as { Notification?: unknown }).Notification = MockNotification;
    (globalThis as { dispatchEvent?: unknown }).dispatchEvent = dispatchEvent;
    (globalThis as { location?: unknown }).location = { assign };

    const { sendOsNotification, WEB_NOTIFICATION_CLICK_EVENT } = await loadModuleForPlatform("web");

    const sent = await sendOsNotification({
      title: "Agent finished",
      body: "Done",
      data: { serverId: "srv-1", agentId: "agent-1" },
    });

    expect(sent).toBe(true);
    expect(created).toHaveLength(1);

    const clicked = created[0];
    expect(clicked.clickListeners).toHaveLength(1);
    clicked.clickListeners[0]?.({} as Event);

    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    const event = dispatchEvent.mock.calls[0]?.[0] as {
      type?: string;
      detail?: { data?: Record<string, unknown> };
    };
    expect(event?.type).toBe(WEB_NOTIFICATION_CLICK_EVENT);
    expect(event?.detail).toEqual({
      data: { serverId: "srv-1", agentId: "agent-1" },
    });
    expect(assign).not.toHaveBeenCalled();
  });

  it("falls back to route navigation when no listener handles the click", async () => {
    const created: MockNotificationInstance[] = [];

    class MockNotification implements MockNotificationInstance {
      static permission = "granted";
      static requestPermission = vi.fn(async () => "granted");
      clickListeners: Array<(event: Event) => void> = [];
      close = vi.fn();

      constructor(
        public title: string,
        public options?: MockNotificationOptions,
      ) {
        created.push(this);
      }

      addEventListener(event: string, listener: (event: Event) => void): void {
        if (event === "click") {
          this.clickListeners.push(listener);
        }
      }
    }

    const dispatchEvent = vi.fn((event: unknown) => {
      void event;
      return true;
    });
    const assign = vi.fn();

    (globalThis as { Notification?: unknown }).Notification = MockNotification;
    (globalThis as { dispatchEvent?: unknown }).dispatchEvent = dispatchEvent;
    (globalThis as { location?: unknown }).location = { assign };

    const { sendOsNotification } = await loadModuleForPlatform("web");

    await sendOsNotification({
      title: "Agent finished",
      data: { serverId: "srv with space", agentId: "agent/1" },
    });

    const clicked = created[0];
    expect(clicked.clickListeners).toHaveLength(1);
    clicked.clickListeners[0]?.({} as Event);

    expect(assign).toHaveBeenCalledWith("/h/srv%20with%20space/agent/agent%2F1");
  });

  it("returns false when the Notification API is unavailable", async () => {
    (globalThis as { Notification?: unknown }).Notification = undefined;
    const { sendOsNotification } = await loadModuleForPlatform("web");
    const sent = await sendOsNotification({
      title: "Agent finished",
      body: "Done",
      data: { serverId: "srv-1", agentId: "agent-1" },
    });

    expect(sent).toBe(false);
  });

  it("does not attach a click handler when there is no route target", async () => {
    const created: MockNotificationInstance[] = [];

    class MockNotification implements MockNotificationInstance {
      static permission = "granted";
      static requestPermission = vi.fn(async () => "granted");
      clickListeners: Array<(event: Event) => void> = [];
      close = vi.fn();

      constructor(
        public title: string,
        public options?: MockNotificationOptions,
      ) {
        created.push(this);
      }

      addEventListener(event: string, listener: (event: Event) => void): void {
        if (event === "click") {
          this.clickListeners.push(listener);
        }
      }
    }

    (globalThis as { Notification?: unknown }).Notification = MockNotification;
    (globalThis as { dispatchEvent?: unknown }).dispatchEvent = vi.fn();
    (globalThis as { location?: unknown }).location = { assign: vi.fn() };

    const { sendOsNotification } = await loadModuleForPlatform("web");

    const sent = await sendOsNotification({
      title: "Paseo notification test",
      body: "If you can see this, desktop notifications work.",
    });

    expect(sent).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0]?.clickListeners).toHaveLength(0);
  });

  it("uses the desktop notification bridge when available", async () => {
    const sendNotification = vi.fn(async () => true);

    const { sendOsNotification } = await loadModuleForPlatform("web", {
      desktopHost: {
        notification: {
          sendNotification,
        },
      },
    });

    const sent = await sendOsNotification({
      title: "Paseo notification test",
      body: "If you can see this, desktop notifications work.",
      data: { serverId: "srv-1" },
    });

    expect(sent).toBe(true);
    expect(sendNotification).toHaveBeenCalledWith({
      title: "Paseo notification test",
      body: "If you can see this, desktop notifications work.",
      data: { serverId: "srv-1" },
    });
  });
});
