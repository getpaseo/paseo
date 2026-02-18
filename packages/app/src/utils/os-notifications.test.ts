import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockNotificationOptions = {
  body?: string;
  data?: Record<string, unknown>;
};

type MockNotificationInstance = {
  title: string;
  options?: MockNotificationOptions;
  onclick: ((event: Event) => void) | null;
  close: ReturnType<typeof vi.fn>;
};

type GlobalSnapshot = {
  Notification: unknown;
  CustomEvent: unknown;
  dispatchEvent: unknown;
  focus: unknown;
  location: unknown;
  __TAURI__: unknown;
};

const originalGlobals: GlobalSnapshot = {
  Notification: (globalThis as { Notification?: unknown }).Notification,
  CustomEvent: (globalThis as { CustomEvent?: unknown }).CustomEvent,
  dispatchEvent: (globalThis as { dispatchEvent?: unknown }).dispatchEvent,
  focus: (globalThis as { focus?: unknown }).focus,
  location: (globalThis as { location?: unknown }).location,
  __TAURI__: (globalThis as { __TAURI__?: unknown }).__TAURI__,
};

async function loadModuleForPlatform(platform: "web" | "ios" | "android") {
  vi.resetModules();
  vi.doMock("react-native", () => ({ Platform: { OS: platform } }));
  return import("./os-notifications");
}

function restoreGlobals(): void {
  (globalThis as { Notification?: unknown }).Notification = originalGlobals.Notification;
  (globalThis as { CustomEvent?: unknown }).CustomEvent = originalGlobals.CustomEvent;
  (globalThis as { dispatchEvent?: unknown }).dispatchEvent = originalGlobals.dispatchEvent;
  (globalThis as { focus?: unknown }).focus = originalGlobals.focus;
  (globalThis as { location?: unknown }).location = originalGlobals.location;
  (globalThis as { __TAURI__?: unknown }).__TAURI__ = originalGlobals.__TAURI__;
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
      onclick: ((event: Event) => void) | null = null;
      close = vi.fn();

      constructor(public title: string, public options?: MockNotificationOptions) {
        created.push(this);
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

    const { sendOsNotification, WEB_NOTIFICATION_CLICK_EVENT } =
      await loadModuleForPlatform("web");

    const sent = await sendOsNotification({
      title: "Agent finished",
      body: "Done",
      data: { serverId: "srv-1", agentId: "agent-1" },
    });

    expect(sent).toBe(true);
    expect(created).toHaveLength(1);

    const clicked = created[0];
    expect(clicked.onclick).toBeTypeOf("function");
    clicked.onclick?.({} as Event);

    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    const event = dispatchEvent.mock.calls[0]?.[0] as unknown as {
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
      onclick: ((event: Event) => void) | null = null;
      close = vi.fn();

      constructor(public title: string, public options?: MockNotificationOptions) {
        created.push(this);
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
    expect(clicked.onclick).toBeTypeOf("function");
    clicked.onclick?.({} as Event);

    expect(assign).toHaveBeenCalledWith("/h/srv%20with%20space/agent/agent%2F1");
  });

  it("uses Tauri notification module when available", async () => {
    const isPermissionGranted = vi.fn(async () => false);
    const requestPermission = vi.fn(async () => "granted");
    const sendNotification = vi.fn(async () => undefined);

    (globalThis as { __TAURI__?: unknown }).__TAURI__ = {
      notification: {
        isPermissionGranted,
        requestPermission,
        sendNotification,
      },
    };

    const { sendOsNotification } = await loadModuleForPlatform("web");
    const sent = await sendOsNotification({
      title: "Agent finished",
      body: "Done",
      data: { serverId: "srv-1", agentId: "agent-1" },
    });

    expect(sent).toBe(true);
    expect(isPermissionGranted).toHaveBeenCalledTimes(1);
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith({
      title: "Agent finished",
      body: "Done",
    });
  });
});
