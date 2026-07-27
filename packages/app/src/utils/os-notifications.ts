import { Asset } from "expo-asset";
import { getDesktopHost } from "@/desktop/host";
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

interface WebServiceWorkerRegistration {
  showNotification: (
    title: string,
    options?: {
      body?: string;
      data?: Record<string, unknown>;
      icon?: string;
    },
  ) => Promise<void>;
}

interface WebServiceWorkerContainer {
  ready?: Promise<WebServiceWorkerRegistration>;
  register: (
    scriptUrl: string,
    options: { scope: string; updateViaCache: "none" },
  ) => Promise<WebServiceWorkerRegistration>;
}

export const WEB_NOTIFICATION_CLICK_EVENT = "paseo:web-notification-click";

let permissionRequest: Promise<boolean> | null = null;
let serviceWorkerRegistrationRequest: Promise<WebServiceWorkerRegistration | null> | null = null;
let notificationIconUrl: string | null | undefined;

const WEB_NOTIFICATION_SERVICE_WORKER_PATH = "/paseo-notification-sw.js";
const WEB_NOTIFICATION_ROUTE_KEY = "__paseoNotificationRoute";

function getDesktopNotificationSender():
  | ((payload: {
      title: string;
      body?: string;
      data?: Record<string, unknown>;
    }) => Promise<boolean>)
  | null {
  const sendNotification = getDesktopHost()?.notification?.sendNotification;
  return typeof sendNotification === "function"
    ? (sendNotification as (payload: {
        title: string;
        body?: string;
        data?: Record<string, unknown>;
      }) => Promise<boolean>)
    : null;
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

function getWebServiceWorkerContainer(): WebServiceWorkerContainer | null {
  return (
    (globalThis as { navigator?: { serviceWorker?: WebServiceWorkerContainer } }).navigator
      ?.serviceWorker ?? null
  );
}

async function ensureWebServiceWorkerRegistration(): Promise<WebServiceWorkerRegistration | null> {
  const serviceWorker = getWebServiceWorkerContainer();
  if (!serviceWorker) {
    return null;
  }
  if (!serviceWorkerRegistrationRequest) {
    serviceWorkerRegistrationRequest = serviceWorker
      .register(WEB_NOTIFICATION_SERVICE_WORKER_PATH, {
        scope: "/",
        updateViaCache: "none",
      })
      .then(async (registration) => {
        return serviceWorker.ready ? await serviceWorker.ready : registration;
      })
      .catch(() => null);
  }

  return await serviceWorkerRegistrationRequest;
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
  )
    .then((permission) => permission === "granted")
    .catch(() => false)
    .finally(() => {
      permissionRequest = null;
    });
  return await permissionRequest;
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
    return await desktopNotificationSender(payload);
  }

  const NotificationConstructor = getWebNotificationConstructor();
  if (NotificationConstructor) {
    const granted = await ensureNotificationPermission();
    if (granted) {
      const options = {
        body: payload.body,
        data: payload.data,
        icon: getWebNotificationIconUrl(),
      };
      const serviceWorkerRegistration = await ensureWebServiceWorkerRegistration();
      if (serviceWorkerRegistration) {
        const serviceWorkerOptions = {
          ...options,
          data: {
            ...payload.data,
            [WEB_NOTIFICATION_ROUTE_KEY]: buildNotificationRoute(payload.data),
          },
        };
        try {
          await serviceWorkerRegistration.showNotification(payload.title, serviceWorkerOptions);
          return true;
        } catch {
          return false;
        }
      }

      let notification: WebNotificationInstance;
      try {
        notification = new NotificationConstructor(
          payload.title,
          options,
        ) as WebNotificationInstance;
      } catch (error) {
        if (error instanceof TypeError) {
          return false;
        }
        throw error;
      }
      if (hasNotificationClickTarget(payload.data)) {
        attachWebClickHandler(notification, payload.data);
      }
      return true;
    }
  }

  return false;
}
