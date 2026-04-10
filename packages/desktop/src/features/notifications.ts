import path from "node:path";
import { existsSync } from "node:fs";
import { execSync } from "child_process";
import { app, BrowserWindow, Notification, ipcMain, nativeImage } from "electron";
import { getNotificationSettings } from "./notification-settings";

type NotificationInput = {
  title?: unknown;
  body?: unknown;
  data?: unknown;
  actions?: Array<{ text: string }>;
};

type NotificationClickPayload = {
  data?: Record<string, unknown>;
};

type NotificationActionPayload = {
  action: string;
  notificationId: string;
  data?: Record<string, unknown>;
};

const activeNotifications = new Set<Notification>();

function toTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function getNotificationIcon(): Electron.NativeImage | null {
  const candidates = [
    path.resolve(__dirname, "../assets/icon.png"),
    path.resolve(__dirname, "../assets/64x64.png"),
    path.resolve(__dirname, "../assets/128x128.png"),
  ];

  for (const iconPath of candidates) {
    if (!existsSync(iconPath)) {
      continue;
    }
    const icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) {
      return icon;
    }
  }

  return null;
}

function focusSenderWindow(sender: Electron.WebContents): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(sender) ?? BrowserWindow.getAllWindows()[0] ?? null;
  if (!win || win.isDestroyed()) {
    return null;
  }
  win.show();
  if (win.isMinimized()) {
    win.restore();
  }
  win.focus();
  return win;
}

function playSystemSound(soundName: string): void {
  if (process.platform !== "darwin") return;
  try {
    const soundPath = `/System/Library/Sounds/${soundName}.aiff`;
    execSync(`osascript -e 'tell app "Finder" to play sound alias "${soundPath}"'`, {
      timeout: 500,
    });
  } catch (error) {
    console.warn("[notifications] Failed to play sound:", error);
  }
}

/**
 * macOS requires a notification to have been shown at least once before
 * the app appears in System Preferences > Notifications. We fire a
 * silent no-op notification during startup to ensure registration.
 */
export function ensureNotificationCenterRegistration(): void {
  if (process.platform !== "darwin" || !Notification.isSupported()) {
    console.warn("[notifications] Notification not supported on this platform");
    return;
  }

  console.info("[notifications] Registering with Notification Center");
  const probe = new Notification({ title: app.name, silent: true });
  probe.on("show", () => {
    console.info("[notifications] Probe notification shown successfully");
    probe.close();
  });
  probe.on("close", () => console.info("[notifications] Probe notification closed"));
  probe.on("failed", (_event, error) => {
    console.error("[notifications] Probe notification failed:", error);
  });
  setTimeout(() => probe.close(), 2_000);
  probe.show();
}

export function registerNotificationHandlers(): void {
  ipcMain.handle("paseo:notification:isSupported", () => {
    const supported = Notification.isSupported();
    console.info("[notifications] Notification.isSupported():", supported);
    return supported;
  });

  ipcMain.handle("paseo:notification:send", async (event, rawInput?: NotificationInput) => {
    console.info("[notifications] send called with:", rawInput);

    if (!Notification.isSupported()) {
      console.warn("[notifications] Notifications not supported");
      return false;
    }

    const title = toTrimmedString(rawInput?.title);
    if (!title) {
      console.warn("[notifications] No title provided");
      return false;
    }

    const settings = getNotificationSettings();
    const body = toTrimmedString(rawInput?.body) ?? undefined;
    const data = toRecord(rawInput?.data);
    const icon = getNotificationIcon();

    const notification = new Notification({
      title,
      ...(body ? { body } : {}),
      ...(icon ? { icon } : {}),
      silent: !settings.isSoundEnabled(),
      actions: rawInput?.actions?.map((a) => ({ type: "button", text: a.text })) ?? [],
    });

    const notificationId = `notif-${Date.now()}`;

    if (settings.isSoundEnabled()) {
      const soundName = settings.getSound();
      notification.on("show", () => playSystemSound(soundName));
    }

    notification.on("action", (_event, index) => {
      const actionText = rawInput?.actions?.[index]?.text;
      if (actionText) {
        const win = focusSenderWindow(event.sender);
        if (win) {
          win.webContents.send("paseo:event:notification-action", {
            action: actionText,
            notificationId,
            data,
          } satisfies NotificationActionPayload);
        }
      }
      activeNotifications.delete(notification);
    });

    notification.on("click", () => {
      const win = focusSenderWindow(event.sender);
      if (win && data && Object.keys(data).length > 0) {
        const payload: NotificationClickPayload = { data };
        win.webContents.send("paseo:event:notification-click", payload);
      }
      activeNotifications.delete(notification);
    });

    notification.on("close", () => {
      activeNotifications.delete(notification);
    });

    notification.on("failed", (_event, error) => {
      console.error("[notifications] Notification failed:", error);
      activeNotifications.delete(notification);
    });

    activeNotifications.add(notification);
    notification.show();
    console.info("[notifications] Notification shown with id:", notificationId);
    return { success: true, notificationId };
  });

  ipcMain.handle("paseo:notification:incrementBadge", () => {
    if (process.platform === "darwin") {
      const current = app.getBadgeCount();
      app.setBadgeCount(current + 1);
    }
  });

  ipcMain.handle("paseo:notification:clearBadge", () => {
    if (process.platform === "darwin") {
      app.setBadgeCount(0);
    }
  });
}
