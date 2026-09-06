import path from "node:path";
import { existsSync } from "node:fs";
import { app, BrowserWindow, Notification, ipcMain, nativeImage } from "electron";
import { showScreenFloatingNotification } from "./screen-notification.js";

interface NotificationInput {
  title?: unknown;
  body?: unknown;
  data?: unknown;
}

interface NotificationClickPayload {
  data?: Record<string, unknown>;
}

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

function focusSenderWindow(sender?: Electron.WebContents): BrowserWindow | null {
  const targetWin = sender ? BrowserWindow.fromWebContents(sender) : null;
  const win =
    targetWin ??
    BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.isResizable()) ??
    null;

  if (!win || win.isDestroyed()) {
    return null;
  }
  if (win.isMinimized()) {
    win.restore();
  }
  win.show();
  // Force foreground bypass on Windows when restored from minimized
  win.setAlwaysOnTop(true);
  win.focus();
  win.setAlwaysOnTop(false);
  return win;
}

/**
 * macOS requires a notification to have been shown at least once before
 * the app appears in System Preferences > Notifications. We fire a
 * silent no-op notification during startup to ensure registration.
 */
export function ensureNotificationCenterRegistration(): void {
  if (process.platform !== "darwin" || !Notification.isSupported()) {
    return;
  }

  const probe = new Notification({ title: app.name, silent: true });
  probe.on("show", () => probe.close());
  setTimeout(() => probe.close(), 2_000);
  probe.show();
}

export function registerNotificationHandlers(): void {
  ipcMain.handle("paseo:notification:isSupported", () => {
    return Notification.isSupported();
  });

  ipcMain.handle("paseo:notification:send", async (event, rawInput?: NotificationInput) => {
    if (!Notification.isSupported()) {
      return false;
    }

    const title = toTrimmedString(rawInput?.title);
    if (!title) {
      return false;
    }

    const body = toTrimmedString(rawInput?.body) ?? undefined;
    const data = toRecord(rawInput?.data);
    const icon = getNotificationIcon();
    // Always silent here: the renderer plays the notification sound itself
    // (app/src/utils/notification-sound) so audio still fires when the OS
    // suppresses the notification entirely (e.g. Windows with notifications
    // disabled), and so the playSound setting has a single sound source.
    // Determine if the app window is currently focused.
    // If the app is in focus, the user sees the in-app toast notification.
    // If the app is minimized / in background / out of focus, show the native OS notification and floating screen popup.
    const senderWin =
      BrowserWindow.fromWebContents(event.sender) ??
      BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.isResizable());
    const isAppFocused = senderWin
      ? senderWin.isFocused() && !senderWin.isMinimized() && senderWin.isVisible()
      : false;

    if (!isAppFocused) {
      const notification = new Notification({
        title,
        ...(body ? { body } : {}),
        ...(icon ? { icon } : {}),
        silent: true,
      });

      activeNotifications.add(notification);

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

      notification.show();

      showScreenFloatingNotification({
        title,
        body,
        data,
        onOpenTarget: (clickData) => {
          const win = focusSenderWindow(event.sender);
          if (win && clickData && Object.keys(clickData).length > 0) {
            const payload: NotificationClickPayload = { data: clickData };
            win.webContents.send("paseo:event:notification-click", payload);
          }
        },
      });
    }

    return true;
  });
}
