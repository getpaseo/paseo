import path from "node:path";
import { existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { app, BrowserWindow, Notification, ipcMain, nativeImage } from "electron";
import { getDesktopSettingsStore } from "../settings/desktop-settings-electron.js";
import type { DesktopSettings } from "../settings/desktop-settings.js";

interface NotificationInput {
  title?: unknown;
  body?: unknown;
  data?: unknown;
}

interface NotificationClickPayload {
  data?: Record<string, unknown>;
}

export interface CustomNotificationSound {
  dataUrl: string;
}

export type ReadNotificationSoundFile = (filePath: string) => Promise<Buffer>;

export interface NotificationSoundPlan {
  silent: boolean;
  playsCustomSound: boolean;
}

export interface NotificationSendResult {
  shown: boolean;
  playsCustomSound: boolean;
}

export const MAX_CUSTOM_SOUND_BYTES = 5 * 1024 * 1024;

const CUSTOM_SOUND_MIME_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".aiff": "audio/aiff",
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

export async function readBoundedFile(filePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

export function planNotificationSound(settings: DesktopSettings): NotificationSoundPlan {
  const { playSound, customSoundPath } = settings.notifications;
  const playsCustomSound = playSound && customSoundPath !== null;
  return { silent: playsCustomSound || !playSound, playsCustomSound };
}

export async function resolveCustomSound(
  settings: DesktopSettings,
  readSoundFile: ReadNotificationSoundFile,
  maxBytes: number = MAX_CUSTOM_SOUND_BYTES,
): Promise<CustomNotificationSound | null> {
  const { playSound, customSoundPath } = settings.notifications;
  if (!playSound || !customSoundPath) {
    return null;
  }

  let contents: Buffer;
  try {
    contents = await readSoundFile(customSoundPath);
  } catch {
    return null;
  }

  if (contents.byteLength === 0 || contents.byteLength > maxBytes) {
    return null;
  }

  const extension = path.extname(customSoundPath).toLowerCase();
  const mimeType = CUSTOM_SOUND_MIME_TYPES[extension] ?? "audio/mpeg";
  return { dataUrl: `data:${mimeType};base64,${contents.toString("base64")}` };
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

  ipcMain.handle("paseo:notification:getCustomSound", async () => {
    const settings = await getDesktopSettingsStore().get();
    return await resolveCustomSound(settings, (filePath) =>
      readBoundedFile(filePath, MAX_CUSTOM_SOUND_BYTES),
    );
  });

  ipcMain.handle(
    "paseo:notification:send",
    async (event, rawInput?: NotificationInput): Promise<NotificationSendResult> => {
      if (!Notification.isSupported()) {
        return { shown: false, playsCustomSound: false };
      }

      const title = toTrimmedString(rawInput?.title);
      if (!title) {
        return { shown: false, playsCustomSound: false };
      }

      const body = toTrimmedString(rawInput?.body) ?? undefined;
      const data = toRecord(rawInput?.data);
      const icon = getNotificationIcon();
      const settings = await getDesktopSettingsStore().get();
      const { silent, playsCustomSound } = planNotificationSound(settings);
      const notification = new Notification({
        title,
        ...(body ? { body } : {}),
        ...(icon ? { icon } : {}),
        silent,
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
      return { shown: true, playsCustomSound };
    },
  );
}
