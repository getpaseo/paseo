export interface UnifiedPushRegistrationConfig {
  enabled: boolean;
  vapidPublicKey: string | null;
}

export interface UnifiedPushServerInfoInput {
  status?: unknown;
  capabilities?: {
    pushNotifications?: {
      webPushVapidPublicKey?: unknown;
    };
  };
  features?: {
    unifiedPush?: unknown;
  };
}

export interface UnifiedPushPlatformInput {
  platform: string;
  serverInfo: UnifiedPushServerInfoInput | null | undefined;
}

export interface UnifiedPushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface UnifiedPushDistributor {
  id: string;
  isInternal?: boolean;
}

export type UnifiedPushEvent =
  | { action: "message"; data: unknown }
  | { action: "registered"; data: unknown }
  | { action: "registrationFailed"; data: unknown }
  | { action: "unregistered"; data: unknown }
  | { action: "error"; data: unknown };

export interface UnifiedPushEventHandlerDependencies {
  getStoredEndpoint: () => Promise<string | null>;
  removeStoredEndpoint: () => Promise<void>;
  registerSubscription: (
    subscription: NonNullable<ReturnType<typeof normalizeRegisteredSubscription>>,
  ) => void;
  setStoredEndpoint: (endpoint: string) => Promise<void>;
  showNotification: (payload: UnifiedPushPayload) => void;
  unregisterSubscription: (endpoint: string) => void;
  warn: (message: string, error?: unknown) => void;
}

export function getUnifiedPushRegistrationConfig(
  input: UnifiedPushPlatformInput,
): UnifiedPushRegistrationConfig {
  const key = input.serverInfo?.capabilities?.pushNotifications?.webPushVapidPublicKey;
  if (input.platform !== "android") return { enabled: false, vapidPublicKey: null };
  if (input.serverInfo?.features?.unifiedPush !== true) {
    return { enabled: false, vapidPublicKey: null };
  }
  if (typeof key !== "string" || key.trim().length === 0) {
    return { enabled: false, vapidPublicKey: null };
  }
  return { enabled: true, vapidPublicKey: key.trim() };
}

export function getUnifiedPushRegistrationTarget(input: UnifiedPushPlatformInput): string | null {
  return getUnifiedPushRegistrationConfig(input).vapidPublicKey;
}

export function selectUnifiedPushDistributor(
  distributors: UnifiedPushDistributor[],
  savedDistributor: string | null,
): UnifiedPushDistributor | null {
  return (
    distributors.find((distributor) => distributor.id === savedDistributor) ??
    distributors.find((distributor) => !distributor.isInternal) ??
    distributors[0] ??
    null
  );
}

export function normalizeRegisteredSubscription(data: unknown) {
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  let endpoint = "";
  if (typeof record.endpoint === "string") {
    endpoint = record.endpoint.trim();
  } else if (typeof record.url === "string") {
    endpoint = record.url.trim();
  }
  const keys =
    record.keys && typeof record.keys === "object" ? (record.keys as Record<string, unknown>) : {};
  let p256dh = "";
  if (typeof keys.p256dh === "string") {
    p256dh = keys.p256dh.trim();
  } else if (typeof record.pubKey === "string") {
    p256dh = record.pubKey.trim();
  }
  let auth = "";
  if (typeof keys.auth === "string") {
    auth = keys.auth.trim();
  } else if (typeof record.auth === "string") {
    auth = record.auth.trim();
  }

  if (!endpoint || !p256dh || !auth) return null;
  return { kind: "webPush" as const, endpoint, keys: { p256dh, auth } };
}

function isUnifiedPushPayload(value: unknown): value is UnifiedPushPayload {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.title === "string" && typeof record.body === "string";
}

export function parseUnifiedPushMessage(data: unknown): UnifiedPushPayload | null {
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  if (record.decrypted !== true || typeof record.message !== "string") return null;

  try {
    const parsed = JSON.parse(record.message) as unknown;
    if (!isUnifiedPushPayload(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function handleUnifiedPushEvent(
  event: UnifiedPushEvent,
  dependencies: UnifiedPushEventHandlerDependencies,
): void {
  if (event.action === "registered") {
    const subscription = normalizeRegisteredSubscription(event.data);
    if (!subscription) {
      dependencies.warn("[UnifiedPush] Ignoring malformed registration payload");
      return;
    }
    void dependencies.setStoredEndpoint(subscription.endpoint);
    dependencies.registerSubscription(subscription);
    return;
  }

  if (event.action === "unregistered") {
    void dependencies.getStoredEndpoint().then((endpoint) => {
      if (!endpoint) return undefined;
      dependencies.unregisterSubscription(endpoint);
      void dependencies.removeStoredEndpoint();
      return undefined;
    });
    return;
  }

  if (event.action === "message") {
    const parsed = parseUnifiedPushMessage(event.data);
    if (!parsed) {
      dependencies.warn("[UnifiedPush] Ignoring malformed push payload");
      return;
    }
    dependencies.showNotification(parsed);
    return;
  }

  if (event.action === "registrationFailed" || event.action === "error") {
    dependencies.warn("[UnifiedPush] Registration or distributor event failed", event.data);
  }
}
