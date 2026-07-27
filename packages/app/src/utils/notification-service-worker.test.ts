import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

interface MockWindowClient {
  focused: boolean;
  visibilityState: "hidden" | "visible";
  navigate: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
}

interface NotificationClickEvent {
  notification: {
    data?: Record<string, unknown>;
    close: ReturnType<typeof vi.fn>;
  };
  waitUntil: (promise: Promise<void>) => void;
}

interface ServiceWorkerHarness {
  click: (event: NotificationClickEvent) => void;
  matchAll: ReturnType<typeof vi.fn>;
  openWindow: ReturnType<typeof vi.fn>;
}

function loadServiceWorker(windows: MockWindowClient[]): ServiceWorkerHarness {
  const source = readFileSync(
    new URL("../../public/paseo-notification-sw.js", import.meta.url),
    "utf8",
  );
  let click: ((event: NotificationClickEvent) => void) | null = null;
  const matchAll = vi.fn(async () => windows);
  const openWindow = vi.fn(async () => undefined);
  const worker = {
    location: { origin: "https://paseo.example" },
    clients: { matchAll, openWindow },
    addEventListener: (type: string, listener: (event: NotificationClickEvent) => void) => {
      if (type === "notificationclick") {
        click = listener;
      }
    },
  };

  runInNewContext(source, { self: worker, URL });
  if (!click) {
    throw new Error("Notification service worker did not register its click handler");
  }

  return { click, matchAll, openWindow };
}

async function dispatchNotificationClick(
  click: ServiceWorkerHarness["click"],
  data?: Record<string, unknown>,
): Promise<ReturnType<typeof vi.fn>> {
  const close = vi.fn();
  let completion: Promise<void> | null = null;
  click({
    notification: { data, close },
    waitUntil: (promise) => {
      completion = promise;
    },
  });
  if (!completion) {
    throw new Error("Notification click was not kept alive with waitUntil");
  }
  await completion;
  return close;
}

describe("notification service worker", () => {
  it("navigates and focuses the active Paseo window", async () => {
    const hiddenWindow: MockWindowClient = {
      focused: false,
      visibilityState: "hidden",
      navigate: vi.fn(async () => undefined),
      focus: vi.fn(async () => undefined),
    };
    const focusedWindow: MockWindowClient = {
      focused: true,
      visibilityState: "visible",
      navigate: vi.fn(async () => undefined),
      focus: vi.fn(async () => undefined),
    };
    const harness = loadServiceWorker([hiddenWindow, focusedWindow]);

    const close = await dispatchNotificationClick(harness.click, {
      __paseoNotificationRoute: "/h/srv-1/agent/agent-1",
    });

    expect(close).toHaveBeenCalledOnce();
    expect(focusedWindow.navigate).toHaveBeenCalledWith(
      "https://paseo.example/h/srv-1/agent/agent-1",
    );
    expect(focusedWindow.focus).toHaveBeenCalledOnce();
    expect(hiddenWindow.navigate).not.toHaveBeenCalled();
    expect(harness.openWindow).not.toHaveBeenCalled();
  });

  it("opens the target route when Paseo has no window", async () => {
    const harness = loadServiceWorker([]);

    await dispatchNotificationClick(harness.click, {
      __paseoNotificationRoute: "/h/srv-1",
    });

    expect(harness.matchAll).toHaveBeenCalledWith({
      type: "window",
      includeUncontrolled: true,
    });
    expect(harness.openWindow).toHaveBeenCalledWith("https://paseo.example/h/srv-1");
  });

  it("falls back to the app root for invalid notification data", async () => {
    const harness = loadServiceWorker([]);

    await dispatchNotificationClick(harness.click, {
      __paseoNotificationRoute: "//attacker.example/session",
    });

    expect(harness.openWindow).toHaveBeenCalledWith("https://paseo.example/");
  });
});
