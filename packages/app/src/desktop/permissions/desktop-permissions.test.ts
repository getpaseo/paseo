import { afterEach, describe, expect, it, vi } from "vitest";

type MockPlatform = "web" | "ios" | "android";

type GlobalSnapshot = {
  Notification: unknown;
  navigatorDescriptor?: PropertyDescriptor;
  windowDescriptor?: PropertyDescriptor;
  paseoDesktop: unknown;
};

const originalGlobals: GlobalSnapshot = {
  Notification: (globalThis as { Notification?: unknown }).Notification,
  navigatorDescriptor: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  windowDescriptor: Object.getOwnPropertyDescriptor(globalThis, "window"),
  paseoDesktop:
    typeof globalThis.window === "undefined"
      ? undefined
      : (globalThis.window as { paseoDesktop?: unknown }).paseoDesktop,
};

function ensureWindow(): { paseoDesktop?: unknown } {
  const existingWindow = (globalThis as { window?: { paseoDesktop?: unknown } }).window;
  if (existingWindow) {
    return existingWindow;
  }

  const nextWindow: { paseoDesktop?: unknown } = {};
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: nextWindow,
  });
  return nextWindow;
}

function setNavigator(value: unknown): void {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value,
  });
}

function restoreGlobals(): void {
  (globalThis as { Notification?: unknown }).Notification = originalGlobals.Notification;

  if (originalGlobals.navigatorDescriptor) {
    Object.defineProperty(globalThis, "navigator", originalGlobals.navigatorDescriptor);
  } else {
    delete (globalThis as { navigator?: unknown }).navigator;
  }

  if (originalGlobals.windowDescriptor) {
    Object.defineProperty(globalThis, "window", originalGlobals.windowDescriptor);
  } else {
    delete (globalThis as { window?: unknown }).window;
  }

  if (typeof globalThis.window !== "undefined") {
    (globalThis.window as { paseoDesktop?: unknown }).paseoDesktop = originalGlobals.paseoDesktop;
  }
}

async function loadModuleForPlatform(platform: MockPlatform) {
  vi.resetModules();
  vi.doMock("react-native", () => ({ Platform: { OS: platform } }));
  return import("./desktop-permissions");
}

describe("desktop-permissions", () => {
  afterEach(() => {
    vi.doUnmock("react-native");
    vi.restoreAllMocks();
    vi.resetModules();
    restoreGlobals();
  });

  it("shows section only in desktop web runtime", async () => {
    const { shouldShowDesktopPermissionSection } = await loadModuleForPlatform("web");

    expect(shouldShowDesktopPermissionSection()).toBe(false);

    ensureWindow().paseoDesktop = {};
    expect(shouldShowDesktopPermissionSection()).toBe(true);
  });

  it("reads notification and microphone status", async () => {
    class MockNotification {
      static permission = "default";
    }
    (globalThis as { Notification?: unknown }).Notification = MockNotification;
    setNavigator({
      permissions: {
        query: vi.fn(async () => ({ state: "granted" })),
      },
      mediaDevices: {
        getUserMedia: vi.fn(),
      },
    });

    const { getDesktopPermissionSnapshot } = await loadModuleForPlatform("web");
    const snapshot = await getDesktopPermissionSnapshot();

    expect(snapshot.notifications.state).toBe("prompt");
    expect(snapshot.microphone.state).toBe("granted");
    expect(snapshot.checkedAt).toBeTypeOf("number");
  });

  it("queries microphone permission with correct Permissions instance binding", async () => {
    const permissions = {
      query(this: unknown, _descriptor: { name: string }) {
        if (this !== permissions) {
          throw new TypeError("Can only call Permissions.query on instances of Permissions");
        }
        return Promise.resolve({ state: "granted" as const });
      },
    };

    setNavigator({
      permissions,
      mediaDevices: {
        getUserMedia: vi.fn(),
      },
    });

    const { getDesktopPermissionSnapshot } = await loadModuleForPlatform("web");
    const snapshot = await getDesktopPermissionSnapshot();

    expect(snapshot.microphone.state).toBe("granted");
  });

  it("returns a fallback message when runtime blocks Permissions.query", async () => {
    setNavigator({
      permissions: {
        query: vi.fn(async () => {
          throw new TypeError("Can only call Permissions.query on instances of Permissions");
        }),
      },
      mediaDevices: {
        getUserMedia: vi.fn(),
      },
    });

    const { getDesktopPermissionSnapshot } = await loadModuleForPlatform("web");
    const snapshot = await getDesktopPermissionSnapshot();

    expect(snapshot.microphone.state).toBe("unknown");
    expect(snapshot.microphone.detail).toContain(
      "Microphone status API is unavailable in this runtime.",
    );
  });

  it("requests notification permission via the browser Notification API", async () => {
    class MockNotification {
      static permission = "default";
      static requestPermission = vi.fn(async () => "granted");
    }
    (globalThis as { Notification?: unknown }).Notification = MockNotification;

    const { requestDesktopPermission } = await loadModuleForPlatform("web");
    const result = await requestDesktopPermission({ kind: "notifications" });

    expect(result.state).toBe("granted");
    expect(MockNotification.requestPermission).toHaveBeenCalledTimes(1);
  });

  it("reads browser Notification permission when available", async () => {
    class MockNotification {
      static permission = "denied";
    }
    (globalThis as { Notification?: unknown }).Notification = MockNotification;
    setNavigator({});

    const { getDesktopPermissionSnapshot } = await loadModuleForPlatform("web");
    const snapshot = await getDesktopPermissionSnapshot();

    expect(snapshot.notifications.state).toBe("denied");
  });

  it("requests microphone permission and stops acquired tracks", async () => {
    const stop = vi.fn();
    const getUserMedia = vi.fn(async () => ({
      getTracks: () => [{ stop }],
    }));
    setNavigator({
      permissions: {
        query: vi.fn(async () => ({ state: "granted" })),
      },
      mediaDevices: {
        getUserMedia,
      },
    });

    const { requestDesktopPermission } = await loadModuleForPlatform("web");
    const result = await requestDesktopPermission({ kind: "microphone" });

    expect(result.state).toBe("granted");
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("maps microphone request denial to denied status", async () => {
    setNavigator({
      mediaDevices: {
        getUserMedia: vi.fn(async () => {
          throw { name: "NotAllowedError", message: "denied" };
        }),
      },
    });

    const { requestDesktopPermission } = await loadModuleForPlatform("web");
    const result = await requestDesktopPermission({ kind: "microphone" });

    expect(result.state).toBe("denied");
  });
});
