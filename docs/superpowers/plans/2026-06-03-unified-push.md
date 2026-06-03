# UnifiedPush Web Push Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full Android UnifiedPush support using standards-based Web Push while preserving existing Expo Push behavior for iOS and legacy clients.

**Architecture:** Keep Expo Push and Web Push as two concrete push channels behind the existing daemon notification sender. Add a typed subscription store, VAPID key management, endpoint SSRF validation, dotted push subscription RPCs, and an Android-only `expo-unified-push` registration path gated by `server_info.features.unifiedPush`.

**Tech Stack:** TypeScript, Zod, Vitest, Node `dns`/`net`/`crypto`, `web-push`, Expo, `expo-unified-push`, `expo-notifications`, AsyncStorage.

---

## File Structure

- Modify `packages/protocol/src/messages.ts`: add Web Push subscription schemas, push subscription RPCs, server_info feature/capability shape, and exported types.
- Add `packages/protocol/src/messages.push-subscription.test.ts`: protocol compatibility tests.
- Modify `packages/client/src/daemon-client.ts`: add `registerPushSubscription` and `unregisterPushSubscription`.
- Modify `packages/client/src/daemon-client.test.ts`: verify client sends new dotted RPCs.
- Modify `packages/server/src/server/push/token-store.ts`: migrate from string token set to typed subscription store.
- Modify `packages/server/src/server/push/token-store.test.ts`: versioned store and legacy migration tests.
- Add `packages/server/src/server/push/vapid-keypair.ts`: private VAPID key loading/generation.
- Add `packages/server/src/server/push/vapid-keypair.test.ts`: keypair persistence tests.
- Add `packages/server/src/server/push/endpoint-security.ts`: Web Push endpoint validation and redaction helpers.
- Add `packages/server/src/server/push/endpoint-security.test.ts`: SSRF validation tests.
- Modify `packages/server/src/server/push/push-service.ts`: split Expo and Web Push sends through injected transports.
- Add `packages/server/src/server/push/push-service.test.ts`: channel routing and cleanup tests.
- Modify `packages/server/src/server/push/notifications.ts`: send all stored subscriptions.
- Modify `packages/server/src/server/websocket-server.ts`: create VAPID keypair, advertise feature/capability, pass store to sessions.
- Modify `packages/server/src/server/session.ts`: handle new push subscription RPCs.
- Modify `packages/server/src/server/websocket-server.relay-reconnect.test.ts`: verify initial `server_info` advertises UnifiedPush and VAPID public key.
- Modify `packages/server/src/server/session.test.ts`: verify push subscription register/unregister RPC responses.
- Modify `packages/app/package.json` and root lockfile: add `expo-unified-push`.
- Modify `packages/server/package.json` and root lockfile: add `web-push` and types if needed.
- Modify `packages/app/app.config.js`: add Android notification permission if `expo-unified-push` does not inject it.
- Add `packages/app/src/push/unified-push-shared.ts`: pure UnifiedPush registration/message parsing helpers.
- Add `packages/app/src/push/unified-push-shared.test.ts`: pure helper tests that do not import native modules.
- Add `packages/app/src/push/unified-push.ts`: Android UnifiedPush boundary module.
- Modify `packages/app/src/hooks/use-push-token-registration.ts`: route Android UnifiedPush vs Expo registration.
- Modify `docs/data-model.md`, `docs/architecture.md`, `docs/android.md`: document subscription store, server capability, and Android UnifiedPush requirements.

## Task 1: Protocol Schemas And Client RPCs

**Files:**
- Modify: `packages/protocol/src/messages.ts`
- Create: `packages/protocol/src/messages.push-subscription.test.ts`
- Modify: `packages/client/src/daemon-client.ts`
- Modify: `packages/client/src/daemon-client.test.ts`

- [ ] **Step 1: Add failing protocol tests**

Create `packages/protocol/src/messages.push-subscription.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import {
  PushSubscriptionRegisterRequestSchema,
  PushSubscriptionRegisterResponseSchema,
  PushSubscriptionUnregisterRequestSchema,
  PushSubscriptionUnregisterResponseSchema,
  RegisterPushTokenMessageSchema,
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

const webPushSubscription = {
  kind: "webPush",
  endpoint: "https://push.example.test/subscription/abc",
  keys: {
    p256dh: "p256dh-key",
    auth: "auth-secret",
  },
} as const;

describe("push subscription protocol", () => {
  test("parses Web Push subscription registration requests", () => {
    const message = {
      type: "push.subscription.register.request",
      requestId: "req-register",
      subscription: webPushSubscription,
    };

    expect(PushSubscriptionRegisterRequestSchema.parse(message)).toEqual(message);
    expect(SessionInboundMessageSchema.parse(message)).toEqual(message);
  });

  test("parses Web Push subscription registration responses", () => {
    const message = {
      type: "push.subscription.register.response",
      payload: {
        requestId: "req-register",
        success: true,
        error: null,
      },
    };

    expect(PushSubscriptionRegisterResponseSchema.parse(message)).toEqual(message);
    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
  });

  test("parses Web Push subscription unregistration messages", () => {
    const request = {
      type: "push.subscription.unregister.request",
      requestId: "req-unregister",
      endpoint: "https://push.example.test/subscription/abc",
    };
    const response = {
      type: "push.subscription.unregister.response",
      payload: {
        requestId: "req-unregister",
        success: false,
        error: "Subscription not found",
      },
    };

    expect(PushSubscriptionUnregisterRequestSchema.parse(request)).toEqual(request);
    expect(PushSubscriptionUnregisterResponseSchema.parse(response)).toEqual(response);
    expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
    expect(SessionOutboundMessageSchema.parse(response)).toEqual(response);
  });

  test("keeps legacy Expo token registration unchanged", () => {
    const message = {
      type: "register_push_token",
      token: "ExponentPushToken[legacy]",
    };

    expect(RegisterPushTokenMessageSchema.parse(message)).toEqual(message);
    expect(SessionInboundMessageSchema.parse(message)).toEqual(message);
  });

  test("parses UnifiedPush feature and VAPID public key in server_info", () => {
    const payload = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "srv_test",
      features: {
        unifiedPush: true,
      },
      capabilities: {
        pushNotifications: {
          webPushVapidPublicKey: "public-vapid-key",
        },
      },
    });

    expect(payload.features?.unifiedPush).toBe(true);
    expect(payload.capabilities?.pushNotifications?.webPushVapidPublicKey).toBe(
      "public-vapid-key",
    );
  });
});
```

- [ ] **Step 2: Run protocol test to verify it fails**

Run:

```bash
npx vitest run packages/protocol/src/messages.push-subscription.test.ts --bail=1
```

Expected: FAIL because the new schemas are not exported yet.

- [ ] **Step 3: Add protocol schemas**

In `packages/protocol/src/messages.ts`, near `RegisterPushTokenMessageSchema`, add:

```ts
export const WebPushSubscriptionSchema = z.object({
  kind: z.literal("webPush"),
  endpoint: z.string().trim().url(),
  keys: z.object({
    p256dh: z.string().trim().min(1),
    auth: z.string().trim().min(1),
  }),
});

export const PushSubscriptionRegisterRequestSchema = z.object({
  type: z.literal("push.subscription.register.request"),
  requestId: z.string(),
  subscription: WebPushSubscriptionSchema,
});

export const PushSubscriptionRegisterResponseSchema = z.object({
  type: z.literal("push.subscription.register.response"),
  payload: z.object({
    requestId: z.string(),
    success: z.boolean(),
    error: z.string().nullable(),
  }),
});

export const PushSubscriptionUnregisterRequestSchema = z.object({
  type: z.literal("push.subscription.unregister.request"),
  requestId: z.string(),
  endpoint: z.string().trim().url(),
});

export const PushSubscriptionUnregisterResponseSchema = z.object({
  type: z.literal("push.subscription.unregister.response"),
  payload: z.object({
    requestId: z.string(),
    success: z.boolean(),
    error: z.string().nullable(),
  }),
});
```

Add the request schemas to `SessionInboundMessageSchema` immediately after `RegisterPushTokenMessageSchema`:

```ts
RegisterPushTokenMessageSchema,
PushSubscriptionRegisterRequestSchema,
PushSubscriptionUnregisterRequestSchema,
```

Add the response schemas to `SessionOutboundMessageSchema` near other RPC responses:

```ts
PushSubscriptionRegisterResponseSchema,
PushSubscriptionUnregisterResponseSchema,
```

Extend `ServerCapabilitiesSchema`:

```ts
export const ServerPushNotificationCapabilitiesSchema = z.object({
  webPushVapidPublicKey: z.string().trim().min(1).optional(),
});

export const ServerCapabilitiesSchema = z
  .object({
    voice: ServerVoiceCapabilitiesSchema.optional(),
    pushNotifications: ServerPushNotificationCapabilitiesSchema.optional(),
  })
  .passthrough();
```

Extend `ServerInfoStatusPayloadSchema.features`:

```ts
// COMPAT(unifiedPush): added in v0.1.90, remove gate after 2026-12-03.
unifiedPush: z.boolean().optional(),
```

Add exported types beside the existing inferred message types:

```ts
export type WebPushSubscription = z.infer<typeof WebPushSubscriptionSchema>;
export type PushSubscriptionRegisterRequest = z.infer<
  typeof PushSubscriptionRegisterRequestSchema
>;
export type PushSubscriptionRegisterResponse = z.infer<
  typeof PushSubscriptionRegisterResponseSchema
>;
export type PushSubscriptionUnregisterRequest = z.infer<
  typeof PushSubscriptionUnregisterRequestSchema
>;
export type PushSubscriptionUnregisterResponse = z.infer<
  typeof PushSubscriptionUnregisterResponseSchema
>;
```

- [ ] **Step 4: Run protocol test to verify it passes**

Run:

```bash
npx vitest run packages/protocol/src/messages.push-subscription.test.ts --bail=1
```

Expected: PASS.

- [ ] **Step 5: Add failing client RPC tests**

In `packages/client/src/daemon-client.test.ts`, add:

```ts
test("registers Web Push subscriptions with dotted RPC", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();
  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const promise = client.registerPushSubscription({
    requestId: "req-push-register",
    subscription: {
      kind: "webPush",
      endpoint: "https://push.example.test/subscription/abc",
      keys: { p256dh: "p256dh-key", auth: "auth-secret" },
    },
  });

  const request = parseSentFrame(mock.sent[0]);
  expect(request).toEqual({
    type: "push.subscription.register.request",
    requestId: "req-push-register",
    subscription: {
      kind: "webPush",
      endpoint: "https://push.example.test/subscription/abc",
      keys: { p256dh: "p256dh-key", auth: "auth-secret" },
    },
  });

  mock.triggerMessage(
    wrapSessionMessage({
      type: "push.subscription.register.response",
      payload: { requestId: "req-push-register", success: true, error: null },
    }),
  );

  await expect(promise).resolves.toEqual({
    requestId: "req-push-register",
    success: true,
    error: null,
  });
});

test("unregisters Web Push subscriptions with dotted RPC", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();
  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const promise = client.unregisterPushSubscription({
    requestId: "req-push-unregister",
    endpoint: "https://push.example.test/subscription/abc",
  });

  const request = parseSentFrame(mock.sent[0]);
  expect(request).toEqual({
    type: "push.subscription.unregister.request",
    requestId: "req-push-unregister",
    endpoint: "https://push.example.test/subscription/abc",
  });

  mock.triggerMessage(
    wrapSessionMessage({
      type: "push.subscription.unregister.response",
      payload: { requestId: "req-push-unregister", success: true, error: null },
    }),
  );

  await expect(promise).resolves.toEqual({
    requestId: "req-push-unregister",
    success: true,
    error: null,
  });
});
```

- [ ] **Step 6: Run client test to verify it fails**

Run:

```bash
npx vitest run packages/client/src/daemon-client.test.ts --bail=1
```

Expected: FAIL because `registerPushSubscription` and `unregisterPushSubscription` do not exist.

- [ ] **Step 7: Add client RPC methods**

In `packages/client/src/daemon-client.ts`, import the new types from `@getpaseo/protocol/messages` if not already included:

```ts
type PushSubscriptionRegisterResponse,
type PushSubscriptionUnregisterResponse,
type WebPushSubscription,
```

Add methods near `registerPushToken`:

```ts
async registerPushSubscription(params: {
  requestId?: string;
  subscription: WebPushSubscription;
}): Promise<PushSubscriptionRegisterResponse["payload"]> {
  return this.sendNamespacedCorrelatedSessionRequest<"push.subscription.register.response">({
    requestId: params.requestId,
    message: {
      type: "push.subscription.register.request",
      subscription: params.subscription,
    },
    timeout: DEFAULT_RPC_TIMEOUT_MS,
  });
}

async unregisterPushSubscription(params: {
  requestId?: string;
  endpoint: string;
}): Promise<PushSubscriptionUnregisterResponse["payload"]> {
  return this.sendNamespacedCorrelatedSessionRequest<"push.subscription.unregister.response">({
    requestId: params.requestId,
    message: {
      type: "push.subscription.unregister.request",
      endpoint: params.endpoint,
    },
    timeout: DEFAULT_RPC_TIMEOUT_MS,
  });
}
```

- [ ] **Step 8: Run protocol and client tests**

Run:

```bash
npx vitest run packages/protocol/src/messages.push-subscription.test.ts --bail=1
npx vitest run packages/client/src/daemon-client.test.ts --bail=1
```

Expected: PASS.

- [ ] **Step 9: Commit protocol and client RPCs**

Run:

```bash
git add packages/protocol/src/messages.ts packages/protocol/src/messages.push-subscription.test.ts packages/client/src/daemon-client.ts packages/client/src/daemon-client.test.ts
git commit -m "feat: add push subscription protocol"
```

## Task 2: Push Subscription Store

**Files:**
- Modify: `packages/server/src/server/push/token-store.ts`
- Modify: `packages/server/src/server/push/token-store.test.ts`
- Modify: `docs/data-model.md`

- [ ] **Step 1: Add failing store tests**

Extend `packages/server/src/server/push/token-store.test.ts` with:

```ts
import { readFileSync } from "node:fs";
```

Add tests:

```ts
test("loads legacy Expo token files as Expo subscriptions", () => {
  const home = mkdtempSync(path.join(tmpdir(), "paseo-push-tokens-"));
  const tokenPath = path.join(home, "push-tokens.json");
  try {
    writeFileSync(
      tokenPath,
      JSON.stringify({ tokens: [" ExponentPushToken[test] ", "", 42] }),
    );

    const store = new PushTokenStore(createLogger(), tokenPath);

    expect(store.getAllSubscriptions()).toEqual([
      {
        kind: "expo",
        token: "ExponentPushToken[test]",
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
    ]);
    expect(store.getAllTokens()).toEqual(["ExponentPushToken[test]"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("persists versioned Expo and Web Push subscriptions", () => {
  const home = mkdtempSync(path.join(tmpdir(), "paseo-push-tokens-"));
  const tokenPath = path.join(home, "push-tokens.json");
  try {
    const store = new PushTokenStore(createLogger(), tokenPath);

    store.addToken("ExponentPushToken[test]");
    store.upsertWebPushSubscription({
      kind: "webPush",
      endpoint: "https://push.example.test/subscription/abc",
      keys: { p256dh: "p256dh-key", auth: "auth-secret" },
    });

    const persisted = JSON.parse(readFileSync(tokenPath, "utf-8"));
    expect(persisted).toEqual({
      version: 2,
      subscriptions: [
        {
          kind: "expo",
          token: "ExponentPushToken[test]",
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        },
        {
          kind: "webPush",
          endpoint: "https://push.example.test/subscription/abc",
          keys: { p256dh: "p256dh-key", auth: "auth-secret" },
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        },
      ],
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("upserts and removes Web Push subscriptions by endpoint", () => {
  const home = mkdtempSync(path.join(tmpdir(), "paseo-push-tokens-"));
  const tokenPath = path.join(home, "push-tokens.json");
  try {
    const store = new PushTokenStore(createLogger(), tokenPath);

    store.upsertWebPushSubscription({
      kind: "webPush",
      endpoint: "https://push.example.test/subscription/abc",
      keys: { p256dh: "first-key", auth: "first-auth" },
    });
    store.upsertWebPushSubscription({
      kind: "webPush",
      endpoint: "https://push.example.test/subscription/abc",
      keys: { p256dh: "second-key", auth: "second-auth" },
    });

    expect(store.getAllSubscriptions()).toEqual([
      {
        kind: "webPush",
        endpoint: "https://push.example.test/subscription/abc",
        keys: { p256dh: "second-key", auth: "second-auth" },
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
    ]);

    store.removeWebPushSubscription("https://push.example.test/subscription/abc");
    expect(store.getAllSubscriptions()).toEqual([]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run store tests to verify they fail**

Run:

```bash
npx vitest run packages/server/src/server/push/token-store.test.ts --bail=1
```

Expected: FAIL because subscription methods do not exist.

- [ ] **Step 3: Implement typed store**

In `packages/server/src/server/push/token-store.ts`, add exported interfaces:

```ts
export interface ExpoPushSubscription {
  kind: "expo";
  token: string;
  createdAt: string;
  updatedAt: string;
}

export interface WebPushSubscription {
  kind: "webPush";
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  createdAt: string;
  updatedAt: string;
}

export type PushSubscription = ExpoPushSubscription | WebPushSubscription;
```

Replace `tokens: Set<string>` with:

```ts
private subscriptions: PushSubscription[] = [];
```

Implement public methods:

```ts
addToken(token: string): void
removeToken(token: string): void
upsertWebPushSubscription(input: Omit<WebPushSubscription, "createdAt" | "updatedAt">): void
removeWebPushSubscription(endpoint: string): void
getAllTokens(): string[]
getAllSubscriptions(): PushSubscription[]
```

Implementation details:

- `addToken` upserts by trimmed Expo token.
- `upsertWebPushSubscription` upserts by trimmed endpoint.
- Preserve `createdAt` on update and refresh `updatedAt`.
- `getAllSubscriptions` returns cloned subscription objects so callers cannot mutate store state.
- `loadFromDisk` accepts legacy `{ tokens: unknown }` and new `{ version: 2, subscriptions: unknown }`.
- Invalid entries are filtered at the file boundary.
- `persist` writes `{ version: 2, subscriptions }`.

- [ ] **Step 4: Run store tests**

Run:

```bash
npx vitest run packages/server/src/server/push/token-store.test.ts --bail=1
```

Expected: PASS.

- [ ] **Step 5: Update data model docs**

In `docs/data-model.md`, replace the Push Token Store section with:

```md
## 8. Push Subscription Store

**Path:** `$PASEO_HOME/push-tokens.json`

~~~json
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
      "keys": { "p256dh": "...", "auth": "..." },
      "createdAt": "2026-06-03T00:00:00.000Z",
      "updatedAt": "2026-06-03T00:00:00.000Z"
    }
  ]
}
~~~

The store accepts the legacy `{ "tokens": [...] }` format and converts entries to Expo subscriptions on load. All writes use the versioned subscription format with atomic temp-file rename.
```

- [ ] **Step 6: Commit subscription store**

Run:

```bash
git add packages/server/src/server/push/token-store.ts packages/server/src/server/push/token-store.test.ts docs/data-model.md
git commit -m "feat: store typed push subscriptions"
```

## Task 3: VAPID Keypair And Endpoint Security

**Files:**
- Create: `packages/server/src/server/push/vapid-keypair.ts`
- Create: `packages/server/src/server/push/vapid-keypair.test.ts`
- Create: `packages/server/src/server/push/endpoint-security.ts`
- Create: `packages/server/src/server/push/endpoint-security.test.ts`
- Modify: `packages/server/package.json`
- Modify: root `package-lock.json`

- [ ] **Step 1: Install server dependency**

Run:

```bash
npm install web-push --workspace=@getpaseo/server
npm install -D @types/web-push --workspace=@getpaseo/server
```

Expected: `packages/server/package.json` and `package-lock.json` update.

- [ ] **Step 2: Add failing VAPID tests**

Create `packages/server/src/server/push/vapid-keypair.test.ts`:

```ts
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type pino from "pino";
import { describe, expect, test } from "vitest";
import { PRIVATE_FILE_MODE } from "../private-files.js";
import { loadOrCreateVapidKeyPair } from "./vapid-keypair.js";

function createLogger(): pino.Logger {
  const logger = {
    child: () => logger,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  };
  return logger as unknown as pino.Logger;
}

describe.skipIf(process.platform === "win32")("VAPID keypair", () => {
  test("creates and reloads a private keypair file", () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-vapid-"));
    const filePath = path.join(home, "push-vapid-keypair.json");
    try {
      const first = loadOrCreateVapidKeyPair(createLogger(), filePath);
      const second = loadOrCreateVapidKeyPair(createLogger(), filePath);

      expect(existsSync(filePath)).toBe(true);
      expect(first).toEqual(second);
      expect(first.publicKey.length).toBeGreaterThan(0);
      expect(first.privateKey.length).toBeGreaterThan(0);
      expect(statSync(filePath).mode & 0o777).toBe(PRIVATE_FILE_MODE);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Add failing endpoint security tests**

Create `packages/server/src/server/push/endpoint-security.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import {
  assertSafeWebPushEndpoint,
  createEndpointLogContext,
  isPublicIpAddress,
} from "./endpoint-security.js";

describe("Web Push endpoint security", () => {
  test("accepts global HTTPS endpoints", async () => {
    await expect(
      assertSafeWebPushEndpoint("https://push.example.test/subscription/abc", {
        resolveHost: async () => ["8.8.8.8"],
      }),
    ).resolves.toEqual(new URL("https://push.example.test/subscription/abc"));
  });

  test("rejects non-HTTPS endpoints", async () => {
    await expect(
      assertSafeWebPushEndpoint("http://push.example.test/subscription/abc", {
        resolveHost: async () => ["8.8.8.8"],
      }),
    ).rejects.toThrow("Web Push endpoint must use HTTPS");
  });

  test("rejects local and private IP resolutions", async () => {
    const blocked = ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.0.1", "::1", "fc00::1"];
    for (const address of blocked) {
      await expect(
        assertSafeWebPushEndpoint("https://push.example.test/subscription/abc", {
          resolveHost: async () => [address],
        }),
      ).rejects.toThrow("Web Push endpoint resolves to a non-public address");
    }
  });

  test("classifies public IP addresses", () => {
    expect(isPublicIpAddress("8.8.8.8")).toBe(true);
    expect(isPublicIpAddress("2001:4860:4860::8888")).toBe(true);
    expect(isPublicIpAddress("169.254.1.1")).toBe(false);
    expect(isPublicIpAddress("224.0.0.1")).toBe(false);
    expect(isPublicIpAddress("0.0.0.0")).toBe(false);
  });

  test("redacts endpoint path and query from log context", () => {
    const context = createEndpointLogContext(
      "https://push.example.test/subscription/secret?token=value",
    );

    expect(context).toEqual({
      endpointHost: "push.example.test",
      endpointHash: expect.stringMatching(/^[a-f0-9]{12}$/),
    });
  });
});
```

- [ ] **Step 4: Run new tests to verify they fail**

Run:

```bash
npx vitest run packages/server/src/server/push/vapid-keypair.test.ts --bail=1
npx vitest run packages/server/src/server/push/endpoint-security.test.ts --bail=1
```

Expected: FAIL because modules do not exist.

- [ ] **Step 5: Implement VAPID keypair module**

Create `packages/server/src/server/push/vapid-keypair.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import type pino from "pino";
import webPush from "web-push";
import { ensurePrivateFile, writePrivateFileAtomicSync } from "../private-files.js";

export interface VapidKeyPair {
  publicKey: string;
  privateKey: string;
}

function parseVapidKeyPair(value: unknown): VapidKeyPair | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.publicKey !== "string" || record.publicKey.trim().length === 0) return null;
  if (typeof record.privateKey !== "string" || record.privateKey.trim().length === 0) return null;
  return {
    publicKey: record.publicKey.trim(),
    privateKey: record.privateKey.trim(),
  };
}

export function loadOrCreateVapidKeyPair(logger: pino.Logger, filePath: string): VapidKeyPair {
  const child = logger.child({ component: "vapid-keypair" });
  if (existsSync(filePath)) {
    try {
      ensurePrivateFile(filePath);
      const parsed = parseVapidKeyPair(JSON.parse(readFileSync(filePath, "utf-8")));
      if (parsed) return parsed;
      child.warn("VAPID keypair file is malformed; regenerating");
    } catch (error) {
      child.warn({ err: error }, "Failed to load VAPID keypair; regenerating");
    }
  }

  const generated = webPush.generateVAPIDKeys();
  const keyPair = {
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
  };
  writePrivateFileAtomicSync(filePath, `${JSON.stringify(keyPair, null, 2)}\n`);
  return keyPair;
}
```

- [ ] **Step 6: Implement endpoint security module**

Create `packages/server/src/server/push/endpoint-security.ts`:

```ts
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface EndpointResolution {
  resolveHost(hostname: string): Promise<string[]>;
}

const defaultResolution: EndpointResolution = {
  async resolveHost(hostname) {
    const results = await lookup(hostname, { all: true });
    return results.map((result) => result.address);
  },
};

export function createEndpointLogContext(endpoint: string): {
  endpointHost: string;
  endpointHash: string;
} {
  const url = new URL(endpoint);
  return {
    endpointHost: url.hostname,
    endpointHash: createHash("sha256").update(endpoint).digest("hex").slice(0, 12),
  };
}

export function isPublicIpAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPublicIpv4(address);
  if (version === 6) return isPublicIpv6(address);
  return false;
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a >= 224) return false;
  return true;
}

function isPublicIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return false;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return false;
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return false;
  if (normalized.startsWith("ff")) return false;
  return true;
}

export async function assertSafeWebPushEndpoint(
  endpoint: string,
  resolution: EndpointResolution = defaultResolution,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("Invalid Web Push endpoint URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("Web Push endpoint must use HTTPS");
  }

  const addresses = await resolution.resolveHost(url.hostname);
  if (addresses.length === 0 || addresses.some((address) => !isPublicIpAddress(address))) {
    throw new Error("Web Push endpoint resolves to a non-public address");
  }

  return url;
}
```

If line length violates formatting, let `npm run format` fix it later.

- [ ] **Step 7: Run security tests**

Run:

```bash
npx vitest run packages/server/src/server/push/vapid-keypair.test.ts --bail=1
npx vitest run packages/server/src/server/push/endpoint-security.test.ts --bail=1
```

Expected: PASS.

- [ ] **Step 8: Commit VAPID and endpoint security**

Run:

```bash
git add packages/server/package.json package-lock.json packages/server/src/server/push/vapid-keypair.ts packages/server/src/server/push/vapid-keypair.test.ts packages/server/src/server/push/endpoint-security.ts packages/server/src/server/push/endpoint-security.test.ts
git commit -m "feat: add web push key and endpoint validation"
```

## Task 4: Server Web Push Sending

**Files:**
- Modify: `packages/server/src/server/push/push-service.ts`
- Create: `packages/server/src/server/push/push-service.test.ts`
- Modify: `packages/server/src/server/push/notifications.ts`

- [ ] **Step 1: Add failing push service tests**

Create `packages/server/src/server/push/push-service.test.ts`:

```ts
import type pino from "pino";
import { describe, expect, test, vi } from "vitest";
import { PushService, type PushPayload } from "./push-service.js";
import type { PushSubscription, PushTokenStore } from "./token-store.js";

function createLogger(): pino.Logger {
  const logger = {
    child: () => logger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger as unknown as pino.Logger;
}

function createStore(subscriptions: PushSubscription[]) {
  const removedExpo: string[] = [];
  const removedWebPush: string[] = [];
  return {
    getAllSubscriptions: () => subscriptions,
    removeToken: (token: string) => removedExpo.push(token),
    removeWebPushSubscription: (endpoint: string) => removedWebPush.push(endpoint),
    removedExpo,
    removedWebPush,
  } as unknown as PushTokenStore & { removedExpo: string[]; removedWebPush: string[] };
}

const payload: PushPayload = {
  title: "Agent finished",
  body: "Done",
  data: { serverId: "srv_test", agentId: "agt_test" },
};

describe("PushService", () => {
  test("routes Expo and Web Push subscriptions to their transports", async () => {
    const expoSend = vi.fn().mockResolvedValue([{ status: "ok" }]);
    const webPushSend = vi.fn().mockResolvedValue(undefined);
    const store = createStore([
      {
        kind: "expo",
        token: "ExponentPushToken[test]",
        createdAt: "2026-06-03T00:00:00.000Z",
        updatedAt: "2026-06-03T00:00:00.000Z",
      },
      {
        kind: "webPush",
        endpoint: "https://push.example.test/subscription/abc",
        keys: { p256dh: "p256dh-key", auth: "auth-secret" },
        createdAt: "2026-06-03T00:00:00.000Z",
        updatedAt: "2026-06-03T00:00:00.000Z",
      },
    ]);

    const service = new PushService(createLogger(), store, {
      expoSend,
      webPushSend,
      validateWebPushEndpoint: async () => undefined,
    });

    await service.sendPush(store.getAllSubscriptions(), payload);

    expect(expoSend).toHaveBeenCalledWith([
      {
        to: "ExponentPushToken[test]",
        title: "Agent finished",
        body: "Done",
        data: { serverId: "srv_test", agentId: "agt_test" },
        sound: "default",
      },
    ]);
    expect(webPushSend).toHaveBeenCalledWith(
      {
        endpoint: "https://push.example.test/subscription/abc",
        keys: { p256dh: "p256dh-key", auth: "auth-secret" },
      },
      JSON.stringify(payload),
    );
  });

  test("removes expired Web Push subscriptions", async () => {
    const store = createStore([
      {
        kind: "webPush",
        endpoint: "https://push.example.test/subscription/expired",
        keys: { p256dh: "p256dh-key", auth: "auth-secret" },
        createdAt: "2026-06-03T00:00:00.000Z",
        updatedAt: "2026-06-03T00:00:00.000Z",
      },
    ]);
    const error = Object.assign(new Error("Gone"), { statusCode: 410 });
    const service = new PushService(createLogger(), store, {
      expoSend: vi.fn(),
      webPushSend: vi.fn().mockRejectedValue(error),
      validateWebPushEndpoint: async () => undefined,
    });

    await service.sendPush(store.getAllSubscriptions(), payload);

    expect(store.removedWebPush).toEqual(["https://push.example.test/subscription/expired"]);
  });

  test("keeps Web Push subscriptions on transient errors", async () => {
    const store = createStore([
      {
        kind: "webPush",
        endpoint: "https://push.example.test/subscription/transient",
        keys: { p256dh: "p256dh-key", auth: "auth-secret" },
        createdAt: "2026-06-03T00:00:00.000Z",
        updatedAt: "2026-06-03T00:00:00.000Z",
      },
    ]);
    const service = new PushService(createLogger(), store, {
      expoSend: vi.fn(),
      webPushSend: vi.fn().mockRejectedValue(Object.assign(new Error("Timeout"), { statusCode: 503 })),
      validateWebPushEndpoint: async () => undefined,
    });

    await service.sendPush(store.getAllSubscriptions(), payload);

    expect(store.removedWebPush).toEqual([]);
  });
});
```

- [ ] **Step 2: Run push service test to verify it fails**

Run:

```bash
npx vitest run packages/server/src/server/push/push-service.test.ts --bail=1
```

Expected: FAIL because `PushService` does not accept transports or subscriptions.

- [ ] **Step 3: Implement concrete Expo and Web Push senders**

In `packages/server/src/server/push/push-service.ts`:

- Import `web-push`, `assertSafeWebPushEndpoint`, `createEndpointLogContext`, and subscription types.
- Keep `PushPayload`, `ExpoPushMessage`, and Expo ticket handling.
- Add interfaces:

```ts
export interface PushServiceTransports {
  expoSend?: (messages: ExpoPushMessage[]) => Promise<ExpoPushTicket[]>;
  webPushSend?: (
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: string,
  ) => Promise<void>;
  validateWebPushEndpoint?: (endpoint: string) => Promise<void>;
}
```

- Constructor becomes:

```ts
constructor(logger: pino.Logger, tokenStore: PushTokenStore, transports: PushServiceTransports = {})
```

- `sendPush` signature becomes:

```ts
async sendPush(subscriptions: PushSubscription[], payload: PushPayload): Promise<void>
```

- Split subscriptions:

```ts
const expoSubscriptions = subscriptions.filter((subscription): subscription is ExpoPushSubscription => subscription.kind === "expo");
const webPushSubscriptions = subscriptions.filter((subscription): subscription is WebPushSubscription => subscription.kind === "webPush");
```

- Expo path maps `subscription.token` into existing messages and batches.
- Web Push path validates endpoint before send and uses `webPush.sendNotification`.
- Configure VAPID details in the constructor only after Task 5 wires keys. For this task, the injected `webPushSend` covers tests and production sender can be a method that calls `webPush.sendNotification`.

- [ ] **Step 4: Update notification sender**

In `packages/server/src/server/push/notifications.ts`, replace token access:

```ts
const subscriptions = tokenStore.getAllSubscriptions();
logger.info({ subscriptionCount: subscriptions.length }, "Sending push notification");
if (subscriptions.length === 0) return;
await pushService.sendPush(subscriptions, payload);
```

- [ ] **Step 5: Run push service and existing notification tests**

Run:

```bash
npx vitest run packages/server/src/server/push/push-service.test.ts --bail=1
npx vitest run packages/server/src/server/websocket-server.notifications.test.ts --bail=1
```

Expected: PASS. If notification tests fail because fakes still use token count wording, update assertions to subscription terminology only where required.

- [ ] **Step 6: Commit push sender**

Run:

```bash
git add packages/server/src/server/push/push-service.ts packages/server/src/server/push/push-service.test.ts packages/server/src/server/push/notifications.ts packages/server/src/server/websocket-server.notifications.test.ts
git commit -m "feat: send notifications through web push"
```

## Task 5: Server Info And Session RPC Handling

**Files:**
- Modify: `packages/server/src/server/websocket-server.ts`
- Modify: `packages/server/src/server/session.ts`
- Modify: `packages/server/src/server/websocket-server.relay-reconnect.test.ts`
- Modify: `packages/server/src/server/session.test.ts`
- Modify: `docs/architecture.md`

- [ ] **Step 1: Add failing server_info test**

In `packages/server/src/server/websocket-server.relay-reconnect.test.ts`, add a VAPID module mock near the existing push mocks:

```ts
vi.mock("./push/vapid-keypair.js", () => ({
  loadOrCreateVapidKeyPair: vi.fn(() => ({
    publicKey: "test-vapid-public-key",
    privateKey: "test-vapid-private-key",
  })),
}));
```

Add a focused test after `"includes voice capabilities in initial server_info when speech readiness exists"`:

```ts
test("includes UnifiedPush feature and Web Push VAPID capability in initial server_info", async () => {
  const server = createServer();

  const socket = new MockSocket();
  const serverInfo = (await attachRelayAndHello({
    server,
    socket,
    clientId: "cid-server-info-unified-push",
  })) as {
    features?: { unifiedPush?: unknown };
    capabilities?: {
      pushNotifications?: { webPushVapidPublicKey?: unknown };
    };
  };

  expect(serverInfo.features?.unifiedPush).toBe(true);
  expect(serverInfo.capabilities?.pushNotifications?.webPushVapidPublicKey).toBe(
    "test-vapid-public-key",
  );

  await server.close();
});
```

- [ ] **Step 2: Add failing session RPC tests**

In `packages/server/src/server/session.test.ts`, add `pushTokenStore` to `SessionForTestOptions`:

```ts
pushTokenStore?: SessionOptions["pushTokenStore"];
```

Change the `createSessionForTest` constructor argument:

```ts
pushTokenStore: options.pushTokenStore ?? asPushTokenStore(),
```

Add tests near the legacy push token registration coverage:

```ts
test("registers Web Push subscriptions through dotted RPC", async () => {
  const messages: unknown[] = [];
  const pushTokenStore = asPushTokenStore();
  pushTokenStore.upsertWebPushSubscription = vi.fn();
  const session = createSessionForTest({ messages, pushTokenStore });

  await session.handleMessage({
    type: "push.subscription.register.request",
    requestId: "req-register",
    subscription: {
      kind: "webPush",
      endpoint: "https://push.example.test/subscription/abc",
      keys: { p256dh: "p256dh-key", auth: "auth-secret" },
    },
  });

  expect(pushTokenStore.upsertWebPushSubscription).toHaveBeenCalledWith({
    kind: "webPush",
    endpoint: "https://push.example.test/subscription/abc",
    keys: { p256dh: "p256dh-key", auth: "auth-secret" },
  });
  expect(messages).toContainEqual({
    type: "push.subscription.register.response",
    payload: { requestId: "req-register", success: true, error: null },
  });
});

test("unregisters Web Push subscriptions through dotted RPC", async () => {
  const messages: unknown[] = [];
  const pushTokenStore = asPushTokenStore();
  pushTokenStore.removeWebPushSubscription = vi.fn();
  const session = createSessionForTest({ messages, pushTokenStore });

  await session.handleMessage({
    type: "push.subscription.unregister.request",
    requestId: "req-unregister",
    endpoint: "https://push.example.test/subscription/abc",
  });

  expect(pushTokenStore.removeWebPushSubscription).toHaveBeenCalledWith(
    "https://push.example.test/subscription/abc",
  );
  expect(messages).toContainEqual({
    type: "push.subscription.unregister.response",
    payload: { requestId: "req-unregister", success: true, error: null },
  });
});
```

- [ ] **Step 3: Run selected server tests to verify they fail**

Run:

```bash
npx vitest run packages/server/src/server/websocket-server.relay-reconnect.test.ts --bail=1
npx vitest run packages/server/src/server/session.test.ts --bail=1
```

Expected: FAIL because server_info and session handling are not implemented.

- [ ] **Step 4: Wire VAPID keypair into websocket server**

In `packages/server/src/server/websocket-server.ts`:

- Import `loadOrCreateVapidKeyPair` and `type VapidKeyPair`.
- Add `private readonly vapidKeyPair: VapidKeyPair;`.
- In constructor after push logger creation:

```ts
this.vapidKeyPair = loadOrCreateVapidKeyPair(
  pushLogger,
  join(paseoHome, "push-vapid-keypair.json"),
);
```

- Pass VAPID keys to `createPushNotificationSender` if Task 4 made production Web Push sends require it:

```ts
createPushNotificationSender(pushLogger, this.pushTokenStore, this.vapidKeyPair)
```

- Extend `buildServerInfoStatusPayload`:

```ts
capabilities: {
  ...(this.serverCapabilities ?? {}),
  pushNotifications: {
    webPushVapidPublicKey: this.vapidKeyPair.publicKey,
  },
},
features: {
  ...
  // COMPAT(unifiedPush): added in v0.1.90, remove gate after 2026-12-03.
  unifiedPush: true,
},
```

Preserve existing `capabilities` when speech readiness is present.

- [ ] **Step 5: Implement session RPC handlers**

In `packages/server/src/server/session.ts`, extend `dispatchMiscMessage`:

```ts
case "push.subscription.register.request":
  this.handlePushSubscriptionRegister(msg);
  return;
case "push.subscription.unregister.request":
  this.handlePushSubscriptionUnregister(msg);
  return;
```

Add methods near `handleRegisterPushToken`:

```ts
private handlePushSubscriptionRegister(
  msg: Extract<SessionInboundMessage, { type: "push.subscription.register.request" }>,
): void {
  try {
    this.pushTokenStore.upsertWebPushSubscription(msg.subscription);
    this.onMessage({
      type: "push.subscription.register.response",
      payload: { requestId: msg.requestId, success: true, error: null },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to register push subscription";
    this.onMessage({
      type: "push.subscription.register.response",
      payload: { requestId: msg.requestId, success: false, error: message },
    });
  }
}

private handlePushSubscriptionUnregister(
  msg: Extract<SessionInboundMessage, { type: "push.subscription.unregister.request" }>,
): void {
  this.pushTokenStore.removeWebPushSubscription(msg.endpoint);
  this.onMessage({
    type: "push.subscription.unregister.response",
    payload: { requestId: msg.requestId, success: true, error: null },
  });
}
```

Endpoint security validation happens in the store or before store upsert if Task 3 exposed sync registration validation. Send-time validation still happens before every Web Push send.

- [ ] **Step 6: Update architecture docs**

In `docs/architecture.md`, add a short bullet near app/server notification description:

```md
- Push notifications use Expo Push for iOS and legacy Android tokens. Android clients on daemons advertising `server_info.features.unifiedPush` may register Web Push subscriptions through UnifiedPush distributors; the daemon sends encrypted Web Push payloads through those endpoints.
```

- [ ] **Step 7: Run selected server tests**

Run:

```bash
npx vitest run packages/server/src/server/websocket-server.relay-reconnect.test.ts --bail=1
npx vitest run packages/server/src/server/session.test.ts --bail=1
npx vitest run packages/server/src/server/push/push-service.test.ts --bail=1
```

Expected: PASS.

- [ ] **Step 8: Commit server RPC and feature advertisement**

Run:

```bash
git add packages/server/src/server/websocket-server.ts packages/server/src/server/session.ts packages/server/src/server/websocket-server.relay-reconnect.test.ts packages/server/src/server/session.test.ts docs/architecture.md
git commit -m "feat: advertise and handle unified push subscriptions"
```

## Task 6: Android UnifiedPush App Integration

**Files:**
- Modify: `packages/app/package.json`
- Modify: root `package-lock.json`
- Modify: `packages/app/app.config.js`
- Add: `packages/app/src/push/unified-push-shared.ts`
- Add: `packages/app/src/push/unified-push-shared.test.ts`
- Add: `packages/app/src/push/unified-push.ts`
- Modify: `packages/app/src/hooks/use-push-token-registration.ts`
- Modify: `docs/android.md`

- [ ] **Step 1: Install app dependency**

Run:

```bash
npm install expo-unified-push --workspace=@getpaseo/app
```

Expected: `packages/app/package.json` and `package-lock.json` update.

- [ ] **Step 2: Add Android permission if missing**

In `packages/app/app.config.js`, ensure Android permissions include:

```js
"android.permission.POST_NOTIFICATIONS",
```

Keep existing permissions unchanged.

- [ ] **Step 3: Create UnifiedPush boundary module**

Inspect the installed package declarations so the boundary module matches the real `expo-unified-push` API:

```bash
sed -n '1,220p' node_modules/expo-unified-push/build/ExpoUnifiedPush.types.d.ts
sed -n '1,220p' node_modules/expo-unified-push/build/index.d.ts
```

Expected: declarations include `registerDevice(vapidPublicKey, instance?)`, distributor shape, and notification/message helpers. Use the declared distributor field names in the next code block; for current `expo-unified-push`, use `id` and `isInternal`.

Create `packages/app/src/push/unified-push-shared.ts`:

```ts
import type { ServerInfoStatusPayload } from "@getpaseo/protocol/messages";

export interface UnifiedPushRegistrationConfig {
  enabled: boolean;
  vapidPublicKey: string | null;
}

export interface UnifiedPushPlatformInput {
  platform: string;
  serverInfo: ServerInfoStatusPayload | null | undefined;
}

export interface UnifiedPushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
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

export function normalizeRegisteredSubscription(data: unknown) {
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const endpoint = typeof record.endpoint === "string" ? record.endpoint.trim() : "";
  const keys = record.keys && typeof record.keys === "object" ? (record.keys as Record<string, unknown>) : {};
  const p256dh =
    typeof keys.p256dh === "string"
      ? keys.p256dh.trim()
      : typeof record.pubKey === "string"
        ? record.pubKey.trim()
        : "";
  const auth =
    typeof keys.auth === "string"
      ? keys.auth.trim()
      : typeof record.auth === "string"
        ? record.auth.trim()
        : "";

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
```

Create `packages/app/src/push/unified-push.ts`:

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import ExpoUnifiedPush, {
  checkPermissions,
  requestPermissions,
  showLocalNotification,
} from "expo-unified-push";
import { subscribeDistributorMessages } from "expo-unified-push/ExpoUnifiedPushModule";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  normalizeRegisteredSubscription,
  parseUnifiedPushMessage,
} from "./unified-push-shared";

const ENDPOINT_STORAGE_PREFIX = "@paseo:web-push-endpoint:";

async function ensureUnifiedPushPermission(): Promise<boolean> {
  if (await checkPermissions()) return true;
  return (await requestPermissions()) === "granted";
}

export async function registerUnifiedPush(params: {
  client: DaemonClient;
  serverId: string;
  vapidPublicKey: string;
}): Promise<void> {
  const granted = await ensureUnifiedPushPermission();
  if (!granted) return;

  const distributors = ExpoUnifiedPush.getDistributors();
  const saved = ExpoUnifiedPush.getSavedDistributor();
  const selected =
    distributors.find((distributor) => distributor.id === saved) ??
    distributors.find((distributor) => !distributor.isInternal) ??
    distributors[0] ??
    null;

  if (!selected) {
    console.warn("[UnifiedPush] No distributor available");
    return;
  }

  ExpoUnifiedPush.saveDistributor(selected.id);
  await ExpoUnifiedPush.registerDevice(params.vapidPublicKey, params.serverId);
}

export function subscribeUnifiedPush(params: {
  client: DaemonClient;
  serverId: string;
}): () => void {
  return subscribeDistributorMessages(({ action, data }) => {
    if (action === "registered") {
      const subscription = normalizeRegisteredSubscription(data);
      if (!subscription) {
        console.warn("[UnifiedPush] Ignoring malformed registration payload");
        return;
      }
      void AsyncStorage.setItem(`${ENDPOINT_STORAGE_PREFIX}${params.serverId}`, subscription.endpoint);
      void params.client.registerPushSubscription({ subscription });
      return;
    }

    if (action === "unregistered") {
      void AsyncStorage.getItem(`${ENDPOINT_STORAGE_PREFIX}${params.serverId}`).then((endpoint) => {
        if (!endpoint) return;
        void params.client.unregisterPushSubscription({ endpoint });
        void AsyncStorage.removeItem(`${ENDPOINT_STORAGE_PREFIX}${params.serverId}`);
      });
      return;
    }

    if (action === "message") {
      const parsed = parseUnifiedPushMessage(data);
      if (!parsed) {
        console.warn("[UnifiedPush] Ignoring malformed push payload");
        return;
      }
      void showLocalNotification({
        id: Date.now(),
        title: parsed.title,
        body: parsed.body,
        data: parsed.data,
      });
    }
  });
}
```

- [ ] **Step 4: Modify push registration hook**

In `packages/app/src/hooks/use-push-token-registration.ts`:

- Import `isNative` if useful from `@/constants/platform`; keep existing `isWeb` behavior.
- Import `registerUnifiedPush` and `subscribeUnifiedPush`.
- Import `getUnifiedPushRegistrationConfig` from `@/push/unified-push-shared`.
- In the registration effect, before Expo token flow:

```ts
if (Platform.OS === "android") {
  const config = getUnifiedPushRegistrationConfig({
    platform: Platform.OS,
    serverInfo: client.getLastServerInfoMessage(),
  });
  if (config.enabled && config.vapidPublicKey) {
    await registerUnifiedPush({ client, serverId, vapidPublicKey: config.vapidPublicKey });
    return;
  }
}
```

- Add an effect for Android UnifiedPush events:

```ts
useEffect(() => {
  if (isWeb || Platform.OS !== "android") return;
  return subscribeUnifiedPush({ client, serverId });
}, [client, serverId]);
```

Keep Expo registration for iOS and unsupported Android exactly as before.

- [ ] **Step 5: Add app tests**

Create `packages/app/src/push/unified-push-shared.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import {
  getUnifiedPushRegistrationConfig,
  normalizeRegisteredSubscription,
  parseUnifiedPushMessage,
} from "./unified-push-shared";

describe("UnifiedPush helpers", () => {
  test("enables Android UnifiedPush only when server advertises feature and VAPID key", () => {
    expect(
      getUnifiedPushRegistrationConfig({
        platform: "android",
        serverInfo: {
          status: "server_info",
          serverId: "srv_test",
          features: { unifiedPush: true },
          capabilities: {
            pushNotifications: { webPushVapidPublicKey: " public-key " },
          },
        },
      }),
    ).toEqual({ enabled: true, vapidPublicKey: "public-key" });

    expect(
      getUnifiedPushRegistrationConfig({
        platform: "ios",
        serverInfo: {
          status: "server_info",
          serverId: "srv_test",
          features: { unifiedPush: true },
          capabilities: {
            pushNotifications: { webPushVapidPublicKey: "public-key" },
          },
        },
      }),
    ).toEqual({ enabled: false, vapidPublicKey: null });

    expect(
      getUnifiedPushRegistrationConfig({
        platform: "android",
        serverInfo: { status: "server_info", serverId: "srv_test" },
      }),
    ).toEqual({ enabled: false, vapidPublicKey: null });
  });

  test("normalizes distributor registration payloads", () => {
    expect(
      normalizeRegisteredSubscription({
        endpoint: " https://push.example.test/subscription/abc ",
        keys: { p256dh: " p256dh-key ", auth: " auth-secret " },
      }),
    ).toEqual({
      kind: "webPush",
      endpoint: "https://push.example.test/subscription/abc",
      keys: { p256dh: "p256dh-key", auth: "auth-secret" },
    });

    expect(
      normalizeRegisteredSubscription({
        endpoint: "https://push.example.test/subscription/abc",
        pubKey: "p256dh-key",
        auth: "auth-secret",
      }),
    ).toEqual({
      kind: "webPush",
      endpoint: "https://push.example.test/subscription/abc",
      keys: { p256dh: "p256dh-key", auth: "auth-secret" },
    });

    expect(normalizeRegisteredSubscription({ endpoint: "https://push.example.test" })).toBeNull();
  });

  test("parses decrypted UnifiedPush messages", () => {
    expect(
      parseUnifiedPushMessage({
        decrypted: true,
        message: JSON.stringify({
          title: "Agent finished",
          body: "Done",
          data: { serverId: "srv_test", agentId: "agt_test" },
        }),
      }),
    ).toEqual({
      title: "Agent finished",
      body: "Done",
      data: { serverId: "srv_test", agentId: "agt_test" },
    });

    expect(parseUnifiedPushMessage({ decrypted: false, message: "{}" })).toBeNull();
    expect(parseUnifiedPushMessage({ decrypted: true, message: "{" })).toBeNull();
    expect(parseUnifiedPushMessage({ decrypted: true, message: JSON.stringify({ title: "x" }) })).toBeNull();
  });
});
```

- [ ] **Step 6: Run app tests**

Run:

```bash
npx vitest run packages/app/src/push/unified-push-shared.test.ts --bail=1
```

Expected: PASS.

- [ ] **Step 7: Update Android docs**

In `docs/android.md`, add:

```md
## UnifiedPush

Android builds support UnifiedPush for devices without Google Play Services when the connected daemon advertises `server_info.features.unifiedPush`. Users need an installed UnifiedPush distributor such as ntfy or Gotify for de-Googled delivery. If no external distributor is installed, the app may fall back to the library's internal FCM-backed distributor on ordinary Android devices.
```

- [ ] **Step 8: Commit Android integration**

Run:

```bash
git add packages/app/package.json package-lock.json packages/app/app.config.js packages/app/src/push/unified-push-shared.ts packages/app/src/push/unified-push-shared.test.ts packages/app/src/push/unified-push.ts packages/app/src/hooks/use-push-token-registration.ts docs/android.md
git commit -m "feat: register android unified push subscriptions"
```

## Task 7: Final Docs And Verification

**Files:**
- Modify: `docs/data-model.md`
- Modify: `docs/architecture.md`
- Modify: `docs/android.md`

- [ ] **Step 1: Run targeted tests from changed areas**

Run:

```bash
npx vitest run packages/protocol/src/messages.push-subscription.test.ts --bail=1
npx vitest run packages/client/src/daemon-client.test.ts --bail=1
npx vitest run packages/server/src/server/push/token-store.test.ts --bail=1
npx vitest run packages/server/src/server/push/vapid-keypair.test.ts --bail=1
npx vitest run packages/server/src/server/push/endpoint-security.test.ts --bail=1
npx vitest run packages/server/src/server/push/push-service.test.ts --bail=1
npx vitest run packages/server/src/server/websocket-server.relay-reconnect.test.ts --bail=1
npx vitest run packages/server/src/server/session.test.ts --bail=1
npx vitest run packages/app/src/push/unified-push-shared.test.ts --bail=1
```

Expected: all PASS.

- [ ] **Step 2: Build workspace declarations before typecheck**

Run:

```bash
npm run build:client
npm run build:server
```

Expected: both complete without TypeScript declaration errors.

- [ ] **Step 3: Run required repo checks**

Run:

```bash
npm run typecheck
npm run lint
```

Expected: both PASS.

- [ ] **Step 4: Format**

Run:

```bash
npm run format
```

Expected: formatter completes. Review `git diff --stat` afterward. The diff should be limited to the files named in Tasks 1-6 plus docs touched in this task.

- [ ] **Step 5: Run final targeted checks if formatter changed code**

If `npm run format` modified TypeScript files, re-run the relevant targeted tests from Step 1 and:

```bash
npm run typecheck
npm run lint
```

Expected: PASS.

- [ ] **Step 6: Commit verification/docs cleanup**

Run:

```bash
git status --short
git add docs/data-model.md docs/architecture.md docs/android.md
git commit -m "docs: document unified push support"
```

Skip this commit if all docs were already committed in prior tasks and there are no remaining changes.

## Self-Review Checklist

- Spec coverage:
  - Protocol gate and RPCs: Task 1.
  - Store migration: Task 2.
  - VAPID and SSRF protection: Task 3.
  - Web Push sending: Task 4.
  - Server advertisement and RPC handling: Task 5.
  - Android registration/message handling: Task 6.
  - Docs and verification: Task 7.
- Placeholder scan: no deferred implementation markers or unspecified implementation tasks.
- Type consistency: `webPush`, `unifiedPush`, `webPushVapidPublicKey`, and dotted RPC names match the design spec.
