import { Asset } from "expo-asset";
import { getDesktopHost, type DesktopNotificationSendResult } from "@/desktop/host";
import { buildNotificationRoute, resolveNotificationTarget } from "./notification-routing";
import { isNative } from "@/constants/platform";

interface OsNotificationPayload {
  title: string;
  body?: string;
  data?: Record<string, unknown>;
}

export interface WebNotificationClickDetail {
  data?: Record<string, unknown>;
}

interface WebNotificationInstance {
  addEventListener: (type: "click", listener: (event: Event) => void) => void;
}

export const WEB_NOTIFICATION_CLICK_EVENT = "paseo:web-notification-click";

let permissionRequest: Promise<boolean> | null = null;
let notificationIconUrl: string | null | undefined;
let customSoundRequest: Promise<string | null> | null = null;

interface NotificationAudio {
  play: () => Promise<void>;
}

export function resetCustomNotificationSound(): void {
  customSoundRequest = null;
}

async function requestCustomNotificationSound(): Promise<string | null> {
  const getCustomSound = getDesktopHost()?.notification?.getCustomSound;
  if (typeof getCustomSound !== "function") {
    return null;
  }
  const sound = await getCustomSound();
  return sound?.dataUrl ?? null;
}

function getAudioConstructor(): (new (src: string) => NotificationAudio) | null {
  return (globalThis as { Audio?: new (src: string) => NotificationAudio }).Audio ?? null;
}

async function playCustomNotificationSound(): Promise<void> {
  try {
    customSoundRequest ??= requestCustomNotificationSound();
    const dataUrl = await customSoundRequest;
    if (!dataUrl) {
      customSoundRequest = null;
      return;
    }
    const AudioConstructor = getAudioConstructor();
    if (!AudioConstructor) {
      return;
    }
    await new AudioConstructor(dataUrl).play();
  } catch {
    customSoundRequest = null;
  }
}

type DesktopNotificationSender = (payload: {
  title: string;
  body?: string;
  data?: Record<string, unknown>;
}) => Promise<boolean | DesktopNotificationSendResult>;

function getDesktopNotificationSender(): DesktopNotificationSender | null {
  const sendNotification = getDesktopHost()?.notification?.sendNotification;
  return typeof sendNotification === "function"
    ? (sendNotification as DesktopNotificationSender)
    : null;
}

function normalizeSendResult(
  result: boolean | DesktopNotificationSendResult,
): DesktopNotificationSendResult {
  return typeof result === "boolean" ? { shown: result, playsCustomSound: result } : result;
}

function getWebNotificationConstructor(): {
  permission: string;
  requestPermission?: () => Promise<string>;
  new (
    title: string,
    options?: {
      body?: string;
      data?: Record<string, unknown>;
      icon?: string;
    },
  ): unknown;
} | null {
  const NotificationConstructor = (
    globalThis as {
      Notification?: {
        permission: string;
        requestPermission?: () => Promise<string>;
        new (
          title: string,
          options?: { body?: string; data?: Record<string, unknown>; icon?: string },
        ): unknown;
      };
    }
  ).Notification;
  return NotificationConstructor ?? null;
}

async function ensureNotificationPermission(): Promise<boolean> {
  const NotificationConstructor = getWebNotificationConstructor();
  if (!NotificationConstructor) {
    return false;
  }
  if (NotificationConstructor.permission === "granted") {
    return true;
  }
  if (NotificationConstructor.permission === "denied") {
    return false;
  }
  if (permissionRequest) {
    return permissionRequest;
  }
  permissionRequest = Promise.resolve(
    NotificationConstructor.requestPermission
      ? NotificationConstructor.requestPermission()
      : "denied",
  ).then((permission) => permission === "granted");
  const result = await permissionRequest;
  permissionRequest = null;
  return result;
}

export async function ensureOsNotificationPermission(): Promise<boolean> {
  if (isNative) {
    return false;
  }
  return await ensureNotificationPermission();
}

function hasNotificationClickTarget(data: Record<string, unknown> | undefined): boolean {
  const target = resolveNotificationTarget(data);
  return target.serverId !== null || target.agentId !== null || target.workspaceId !== null;
}

function getWebNotificationIconUrl(): string | undefined {
  if (notificationIconUrl !== undefined) {
    return notificationIconUrl ?? undefined;
  }

  try {
    const asset = Asset.fromModule(require("../../assets/images/notification-icon.png"));
    notificationIconUrl = asset.uri ?? null;
  } catch {
    notificationIconUrl = null;
  }

  return notificationIconUrl ?? undefined;
}

function dispatchWebNotificationClick(detail: WebNotificationClickDetail): boolean {
  const dispatch = (globalThis as { dispatchEvent?: (event: Event) => boolean }).dispatchEvent;
  const CustomEventConstructor = (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent;

  if (typeof dispatch !== "function" || !CustomEventConstructor) {
    return false;
  }

  const event = new CustomEventConstructor<WebNotificationClickDetail>(
    WEB_NOTIFICATION_CLICK_EVENT,
    {
      detail,
      cancelable: true,
    },
  );
  return !dispatch(event);
}

function fallbackNavigateToNotificationTarget(data: Record<string, unknown> | undefined): void {
  const route = buildNotificationRoute(data);
  const location = (globalThis as { location?: { assign?: (url: string) => void; href?: string } })
    .location;
  if (!location) {
    return;
  }
  if (typeof location.assign === "function") {
    location.assign(route);
    return;
  }
  if (typeof location.href === "string") {
    location.href = route;
  }
}

function attachWebClickHandler(
  notification: WebNotificationInstance,
  data: Record<string, unknown> | undefined,
): void {
  notification.addEventListener("click", () => {
    const handledByApp = dispatchWebNotificationClick({ data });
    if (!handledByApp) {
      fallbackNavigateToNotificationTarget(data);
    }
  });
}

export async function sendOsNotification(payload: OsNotificationPayload): Promise<boolean> {
  // Mobile/native notifications should be remote push only.
  if (isNative) {
    return false;
  }

  const desktopNotificationSender = getDesktopNotificationSender();
  if (desktopNotificationSender) {
    const result = normalizeSendResult(await desktopNotificationSender(payload));
    if (result.playsCustomSound) {
      await playCustomNotificationSound();
    }
    return result.shown;
  }

  const NotificationConstructor = getWebNotificationConstructor();
  if (NotificationConstructor) {
    const granted = await ensureNotificationPermission();
    if (granted) {
      const notification = new NotificationConstructor(payload.title, {
        body: payload.body,
        data: payload.data,
        icon: getWebNotificationIconUrl(),
      }) as WebNotificationInstance;
      if (hasNotificationClickTarget(payload.data)) {
        attachWebClickHandler(notification, payload.data);
      }
      return true;
    }
  }

  return false;
}
