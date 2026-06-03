# UnifiedPush/Web Push Design

## Goal

Add full Android UnifiedPush support so Paseo can deliver mobile push notifications on Android devices without Google Play Services or FCM. The daemon sends standards-based Web Push messages to UnifiedPush distributor endpoints, while iOS keeps the existing Expo/APNs path and web/desktop notification behavior stays unchanged.

## Non-Goals

- Do not add an ntfy-only webhook shortcut.
- Do not replace iOS Expo Push.
- Do not add a degraded UnifiedPush fallback for old daemons. New Android UnifiedPush registration runs only when the connected daemon advertises support.
- Do not change notification routing semantics. Existing agent attention payloads and click navigation remain the source of truth.

## Current State

Server-side push is Expo-only. `PushService` maps every stored string token into an Expo push message and posts batches to `https://exp.host/--/api/v2/push/send`. `PushTokenStore` persists `{ "tokens": ["ExponentPushToken[...]"] }` and filters only for non-empty strings.

The app currently registers a native push token through `expo-notifications` for all native platforms. The daemon protocol accepts the legacy session message `{ type: "register_push_token", token: string }`, so old clients and old daemons only understand opaque Expo token strings.

## Approach

Use the Web Push standard end to end for Android UnifiedPush.

- Android app: use the in-repo `paseo-unified-push` Expo module to select a UnifiedPush distributor, request notification permission, register with the daemon's VAPID public key, and receive registration/message/unregistration events.
- Daemon: generate and persist a VAPID keypair, store Web Push subscriptions, send notification payloads through `web-push`, and keep the existing Expo channel for legacy Android and iOS tokens.
- Protocol: keep `register_push_token` for Expo compatibility and add a dotted RPC for Web Push subscriptions.

This keeps Expo Push and Web Push as concrete channels instead of inventing a broad provider framework before more channels exist.

## Protocol

### Server Feature Gate

The daemon advertises UnifiedPush support through `server_info.features.unifiedPush: true` with a cleanup tag:

```ts
// COMPAT(unifiedPush): added in v0.1.90, remove gate after 2026-12-03.
unifiedPush: true,
```

The daemon also exposes the VAPID public key in `server_info.capabilities.pushNotifications.webPushVapidPublicKey`. `ServerCapabilitiesSchema` already uses `.passthrough()`, so this is backward-compatible. New clients parse it; old clients ignore it.

The app enables Android UnifiedPush registration only when both are present:

- `serverInfo.features?.unifiedPush === true`
- `typeof serverInfo.capabilities?.pushNotifications?.webPushVapidPublicKey === "string"`

### New Messages

Add new session RPCs using the dotted namespace convention:

```ts
push.subscription.register.request;
push.subscription.register.response;
push.subscription.unregister.request;
push.subscription.unregister.response;
```

Register request shape:

```ts
{
  type: "push.subscription.register.request";
  requestId: string;
  subscription: {
    kind: "webPush";
    endpoint: string;
    keys: {
      p256dh: string;
      auth: string;
    }
  }
}
```

Register response shape:

```ts
{
  type: "push.subscription.register.response";
  payload: {
    requestId: string;
    success: boolean;
    error: string | null;
  }
}
```

Unregister request shape:

```ts
{
  type: "push.subscription.unregister.request";
  requestId: string;
  endpoint: string;
}
```

Unregister response uses the same response payload shape as register.

The legacy `register_push_token` remains accepted and still stores Expo tokens. It is not repurposed for Web Push URLs because that would cause new Android clients to silently mis-register against old daemons.

## Data Model

Replace the in-memory token set with a subscription set keyed by stable channel identity.

```ts
interface ExpoPushSubscription {
  kind: "expo";
  token: string;
  createdAt: string;
  updatedAt: string;
}

interface WebPushSubscription {
  kind: "webPush";
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  createdAt: string;
  updatedAt: string;
}

type PushSubscription = ExpoPushSubscription | WebPushSubscription;
```

Persist `$PASEO_HOME/push-tokens.json` in a new versioned format:

```json
{
  "version": 2,
  "subscriptions": [
    {
      "kind": "expo",
      "token": "ExponentPushToken[...]",
      "createdAt": "2026-06-03T00:00:00.000Z",
      "updatedAt": "2026-06-03T00:00:00.000Z"
    },
    {
      "kind": "webPush",
      "endpoint": "https://push.example/subscription/...",
      "keys": {
        "p256dh": "...",
        "auth": "..."
      },
      "createdAt": "2026-06-03T00:00:00.000Z",
      "updatedAt": "2026-06-03T00:00:00.000Z"
    }
  ]
}
```

Compatibility: when loading old `{ tokens: string[] }`, convert each non-empty string to `kind: "expo"` with current timestamps and write the new format on the next persistence event. The docs must update the Push Token Store section to describe subscriptions, not Expo-only tokens.

## VAPID Key Management

The daemon owns the Web Push VAPID keypair.

- Store it at `$PASEO_HOME/push-vapid-keypair.json` with private file permissions.
- Generate it on first use with `web-push.generateVAPIDKeys()`.
- Expose only the public key to clients through `server_info.capabilities.pushNotifications.webPushVapidPublicKey`.
- Keep the private key server-side and never log it.

The VAPID subject is `mailto:hello@moboudra.com`. Do not add user-facing configuration in the first version.

## Server Sending

Split push sending into two concrete paths:

- Expo path: preserve current batch behavior and invalid-token cleanup for Expo errors such as `DeviceNotRegistered` and `InvalidCredentials`.
- Web Push path: send the same `PushPayload` as JSON using `web-push.sendNotification(subscription, JSON.stringify(payload))`.

The notification payload remains:

```ts
interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}
```

On Web Push HTTP `404` or `410`, remove the subscription. For other failures, log a warning with redacted endpoint metadata and keep the subscription.

## Endpoint Security

Web Push endpoints are capability URLs and SSRF input. Apply validation at registration and before every send.

Registration validation:

- Parse with `new URL(endpoint)`.
- Require `https:`.
- Require `p256dh` and `auth` to be non-empty strings.
- Store the endpoint, but never log the full value.

Send-time network validation:

- Resolve the endpoint hostname.
- Reject localhost, loopback, private RFC1918, link-local, multicast, unique-local IPv6, and unspecified addresses.
- Re-check immediately before sending so DNS rebinding cannot turn an already registered endpoint into a local target.

Logging:

- Include endpoint hostname and a short hash of the endpoint.
- Do not log query strings, path, full endpoint, keys, or payload data.

## Android App

Use the in-repo `paseo-unified-push` module only on Android and only after daemon support is confirmed.

Registration flow:

1. Read `server_info` from the connected daemon.
2. If UnifiedPush is unavailable, use existing Expo registration path.
3. If UnifiedPush is available, call `PaseoUnifiedPush.getDistributors()` and select a distributor.
4. Prefer a non-internal distributor when one exists; otherwise use the embedded FCM-backed distributor only as an explicit fallback to preserve working push on ordinary Android devices.
5. Save the distributor with `PaseoUnifiedPush.saveDistributor(distributor.id)`.
6. Request Android `POST_NOTIFICATIONS`.
7. Call `PaseoUnifiedPush.registerDevice(webPushVapidPublicKey, serverId)`.
8. On `registered`, send `push.subscription.register.request` with the registration payload returned by the connector.
9. On `unregistered`, send `push.subscription.unregister.request` for the last registered endpoint saved in `AsyncStorage`.

Message flow:

1. Subscribe to `PaseoUnifiedPush` service events.
2. On `message`, require `data.decrypted === true`.
3. Parse `data.message` as JSON `PushPayload`.
4. The Android PushService shows a local notification carrying `title`, `body`, and `data` so background delivery works even when JS is not active.
5. Preserve the existing `_layout.tsx` notification response handling so taps continue to navigate through current notification routing.

If the app receives malformed push JSON, it logs a warning and does not show a notification.

The first version does not add a distributor picker UI. Automatic selection keeps scope focused on restoring push functionality. If no usable distributor is available, registration records a local unavailable state, logs a concise warning, and leaves the existing app session usable.

## iOS, Web, And Desktop

iOS keeps `expo-notifications` + Expo Push because APNs works independently of FCM. Browser web and Electron desktop keep existing local OS notification behavior. No UnifiedPush code should load on iOS, web, or desktop.

## Testing

Follow repo testing rules: no full suite, targeted tests only, then `npm run typecheck` and `npm run lint` after implementation.

Server tests:

- `push` store loads old `{ tokens: string[] }` and exposes Expo subscriptions.
- Store persists version 2 subscriptions with private permissions.
- Register Web Push subscription validates required fields.
- HTTP send path routes Expo subscriptions to Expo and Web Push subscriptions to Web Push.
- Web Push `404`/`410` removes a subscription.
- Endpoint validator rejects localhost/private/link-local/multicast addresses.

Protocol/client tests:

- New dotted RPC schemas parse valid register/unregister messages.
- Old `register_push_token` still parses unchanged.
- `server_info` accepts `features.unifiedPush` and `capabilities.pushNotifications.webPushVapidPublicKey`.

App tests:

- Android chooses UnifiedPush only when the daemon advertises feature and VAPID key.
- iOS and unsupported Android keep using Expo registration.
- Registered distributor event sends a Web Push subscription RPC.
- Unregistered event unregisters the saved endpoint.
- Message event with decrypted JSON shows a local notification with existing routing data.

## Rollout And Compatibility

New app with old daemon: Android sees no `features.unifiedPush`, so it keeps existing Expo registration path.

Old app with new daemon: old app continues sending `register_push_token`; daemon stores it as an Expo subscription and sends through Expo.

New app with new daemon: Android uses UnifiedPush/Web Push, iOS uses Expo, web/desktop unchanged.

The store migration is read-compatible with existing token files. Once written, old daemon versions may not understand the new file shape, so this is a normal forward data migration. The protocol remains backward-compatible.

## Documentation Updates

Update:

- `docs/data-model.md`: describe versioned push subscriptions and VAPID keypair file.
- `docs/architecture.md`: describe Expo + Web Push channels in notification flow.
- `docs/android.md`: note UnifiedPush support and distributor requirement for de-Googled devices.

## Open Risks

- The in-repo Android module depends on UnifiedPush connector libraries. Implementation must verify it works with Expo prebuild and the current React Native/Expo versions.
- Automatic distributor selection may choose an internal FCM-backed distributor when no external distributor is installed. That preserves ordinary Android behavior but does not solve de-Googled devices unless the user installs a real distributor.
- Background delivery behavior depends on the native PushService. The implementation must verify notifications appear when the app process is backgrounded or killed.
