import path from "node:path";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { app, BrowserWindow, Notification, ipcMain, nativeImage } from "electron";
import { getDesktopSettingsStore } from "../settings/desktop-settings-electron.js";

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

function getNotificationIconPath(): string | null {
  const candidates = [
    path.resolve(__dirname, "../assets/icon.png"),
    path.resolve(__dirname, "../assets/64x64.png"),
    path.resolve(__dirname, "../assets/128x128.png"),
  ];

  return candidates.find((iconPath) => existsSync(iconPath)) ?? null;
}

function getNotificationIcon(): Electron.NativeImage | null {
  const iconPath = getNotificationIconPath();
  if (!iconPath) {
    return null;
  }
  const icon = nativeImage.createFromPath(iconPath);
  return icon.isEmpty() ? null : icon;
}

/**
 * GNOME/Mutter plays no sound for a notification unless the app attaches a
 * sound hint. Electron's Notification API exposes no hint knob, so a bare
 * Electron notification on Linux is always silent even with `silent: false`
 * (the Play sound toggle). Delivering through `notify-send` with the
 * `sound-name` hint verified on Ubuntu (`complete`) makes the OS play it.
 */
export const LINUX_NOTIFICATION_SOUND_NAME = "complete";
const NOTIFY_SEND_BIN = "notify-send";
const NOTIFY_SEND_SPAWN_GRACE_MS = 300;
const NOTIFY_SEND_BACKSTOP_MS = 5 * 60_000;
const NOTIFY_SEND_ACTION_ID = "default";

export interface LinuxSoundNotification {
  appName: string;
  iconPath: string | null;
  title: string;
  body?: string;
}

export function shouldUseLinuxSoundNotification(platform: string, playSound: boolean): boolean {
  return platform === "linux" && playSound;
}

export function buildNotifySendArgs(input: LinuxSoundNotification): string[] {
  const args = [
    "-a",
    input.appName,
    "-u",
    "normal",
    "-h",
    `string:sound-name:${LINUX_NOTIFICATION_SOUND_NAME}`,
    "-A",
    `${NOTIFY_SEND_ACTION_ID}=Open`,
  ];
  if (input.iconPath) {
    args.push("-i", input.iconPath);
  }
  args.push(input.title);
  if (input.body) {
    args.push(input.body);
  }
  return args;
}

export interface NotifySendProcess {
  on(event: string, listener: (...args: unknown[]) => void): void;
  unref(): void;
  kill(): void;
  stdout: { on(event: string, listener: (chunk: unknown) => void): void } | null;
}

export type NotifySendSpawner = (command: string, args: string[]) => NotifySendProcess;

const defaultNotifySendSpawner: NotifySendSpawner = (command, args) =>
  spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] }) as unknown as NotifySendProcess;

/**
 * Hand a notification to the OS via notify-send with a sound hint.
 * Resolves true once the OS accepted it (or the action was clicked fast);
 * false when notify-send is missing/fails so the caller can fall back to
 * Electron's Notification. Late clicks still reach onAction.
 */
export async function sendLinuxNotificationWithSound(
  input: LinuxSoundNotification,
  onAction?: (actionId: string) => void,
  spawner: NotifySendSpawner = defaultNotifySendSpawner,
  spawnGraceMs: number = NOTIFY_SEND_SPAWN_GRACE_MS,
): Promise<boolean> {
  let child: NotifySendProcess;
  try {
    child = spawner(NOTIFY_SEND_BIN, buildNotifySendArgs(input));
  } catch {
    return false;
  }
  child.unref();
  const backstop = setTimeout(() => {
    try {
      child.kill();
    } catch {
      // Already exited; nothing to stop.
    }
  }, NOTIFY_SEND_BACKSTOP_MS);
  backstop.unref();

  const output: string[] = [];
  child.stdout?.on("data", (chunk) => {
    output.push(String(chunk));
  });

  let resolveOutcome!: (value: boolean) => void;
  const outcome = new Promise<boolean>((innerResolve) => {
    resolveOutcome = innerResolve;
  });
  // One settlement path for error/close/grace, guarded by `done`.
  let done = false;
  const finish = (value: boolean) => {
    if (done) {
      return;
    }
    done = true;
    clearTimeout(grace);
    clearTimeout(backstop);
    resolveOutcome(value);
  };
  const grace = setTimeout(() => finish(true), spawnGraceMs);
  grace.unref();
  child.on("error", () => {
    finish(false);
  });
  child.on("close", (code) => {
    const actionId = output.join("").trim();
    if (actionId) {
      onAction?.(actionId);
    }
    if (!done && typeof code === "number" && code !== 0 && !actionId) {
      finish(false);
      return;
    }
    finish(true);
  });
  return outcome;
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
    const settings = await getDesktopSettingsStore().get();

    if (shouldUseLinuxSoundNotification(process.platform, settings.notifications.playSound)) {
      const sent = await sendLinuxNotificationWithSound(
        {
          appName: app.name,
          iconPath: getNotificationIconPath(),
          title,
          ...(body ? { body } : {}),
        },
        (actionId) => {
          if (actionId !== NOTIFY_SEND_ACTION_ID) {
            return;
          }
          const win = focusSenderWindow(event.sender);
          if (win && data && Object.keys(data).length > 0) {
            const payload: NotificationClickPayload = { data };
            win.webContents.send("paseo:event:notification-click", payload);
          }
        },
      );
      if (sent) {
        return true;
      }
      // notify-send missing or failed: fall through to Electron's banner.
    }

    const icon = getNotificationIcon();
    const notification = new Notification({
      title,
      ...(body ? { body } : {}),
      ...(icon ? { icon } : {}),
      silent: !settings.notifications.playSound,
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
    return true;
  });
}
