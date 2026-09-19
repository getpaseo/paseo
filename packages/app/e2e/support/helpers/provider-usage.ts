import { expect, type Page } from "@playwright/test";
import type { ProviderUsage } from "@getpaseo/protocol/messages";
import { gotoAppShell, openSettings } from "./app";
import { daemonWsRoutePattern } from "./daemon-port";
import { getServerId } from "./server-id";
import { openSettingsHostSection } from "./settings";

interface ProviderUsageFixturePayload {
  fetchedAt: string;
  providers: ProviderUsage[];
}

export interface ProviderUsageFixture {
  requestCount(): number;
  releaseNextResponse(): void;
  waitForRequestCount(count: number): Promise<void>;
}

interface ProviderUsageBalanceWithinCardInput {
  page: Page;
  provider: ProviderUsage;
  balanceId: string;
}

export async function expectProviderUsageBalanceWithinCard({
  page,
  provider,
  balanceId,
}: ProviderUsageBalanceWithinCardInput): Promise<void> {
  const serverId = getServerId();
  await installProviderUsageFixture({
    page,
    payloads: [
      {
        fetchedAt: "2026-06-19T00:00:00.000Z",
        providers: [provider],
      },
    ],
  });
  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsHostSection(page, serverId, "usage");

  const card = page.getByTestId("provider-usage-card");
  const value = page.getByTestId(`provider-usage-balance-${balanceId}-value`);
  await expect(value).toBeVisible({ timeout: 10_000 });
  const [cardBox, valueBox] = await Promise.all([card.boundingBox(), value.boundingBox()]);
  expect(cardBox).not.toBeNull();
  expect(valueBox).not.toBeNull();
  expect((valueBox?.x ?? 0) + (valueBox?.width ?? 0)).toBeLessThanOrEqual(
    (cardBox?.x ?? 0) + (cardBox?.width ?? 0),
  );
}

interface ProviderUsageFixtureInput {
  page: Page;
  payloads: ProviderUsageFixturePayload[];
  deferResponses?: boolean;
}

type WebSocketMessage = string | Buffer;

function parseJson(message: WebSocketMessage): unknown {
  const raw = typeof message === "string" ? message : message.toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getSessionMessage(message: WebSocketMessage): Record<string, unknown> | null {
  const envelope = parseJson(message);
  if (!envelope || typeof envelope !== "object") {
    return null;
  }
  const maybeEnvelope = envelope as { type?: unknown; message?: unknown };
  if (maybeEnvelope.type !== "session" || !maybeEnvelope.message) {
    return null;
  }
  if (typeof maybeEnvelope.message !== "object") {
    return null;
  }
  return maybeEnvelope.message as Record<string, unknown>;
}

function withProviderUsageFeature(message: WebSocketMessage): string | null {
  const envelope = parseJson(message);
  if (!envelope || typeof envelope !== "object") {
    return null;
  }
  const maybeEnvelope = envelope as {
    type?: unknown;
    message?: {
      type?: unknown;
      payload?: Record<string, unknown>;
    };
  };
  const payload = maybeEnvelope.message?.payload;
  if (
    maybeEnvelope.type !== "session" ||
    maybeEnvelope.message?.type !== "status" ||
    payload?.status !== "server_info"
  ) {
    return null;
  }
  return JSON.stringify({
    ...maybeEnvelope,
    message: {
      ...maybeEnvelope.message,
      payload: {
        ...payload,
        features: {
          ...(typeof payload.features === "object" && payload.features !== null
            ? payload.features
            : {}),
          providerUsageList: true,
        },
      },
    },
  });
}

export async function installProviderUsageFixture({
  page,
  payloads,
  deferResponses = false,
}: ProviderUsageFixtureInput): Promise<ProviderUsageFixture> {
  let requests = 0;
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  const pendingResponses: Array<() => void> = [];

  function notifyWaiters() {
    for (const waiter of waiters.splice(0)) {
      if (requests >= waiter.count) {
        waiter.resolve();
      } else {
        waiters.push(waiter);
      }
    }
  }

  function payloadForRequest(): ProviderUsageFixturePayload {
    const index = Math.min(requests - 1, payloads.length - 1);
    const payload = payloads[index];
    if (!payload) {
      throw new Error("Provider usage fixture requires at least one payload.");
    }
    return payload;
  }

  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();

    ws.onMessage((message) => {
      const sessionMessage = getSessionMessage(message);
      if (sessionMessage?.type === "provider.usage.list.request") {
        requests += 1;
        const requestId = sessionMessage.requestId;
        if (typeof requestId !== "string") {
          throw new Error("provider.usage.list.request missing requestId");
        }
        const payload = payloadForRequest();
        notifyWaiters();
        const sendResponse = () => {
          ws.send(
            JSON.stringify({
              type: "session",
              message: {
                type: "provider.usage.list.response",
                payload: {
                  requestId,
                  fetchedAt: payload.fetchedAt,
                  providers: payload.providers,
                },
              },
            }),
          );
        };
        if (deferResponses) {
          pendingResponses.push(sendResponse);
        } else {
          sendResponse();
        }
        return;
      }
      server.send(message);
    });

    server.onMessage((message) => {
      const serverInfo = typeof message === "string" ? withProviderUsageFeature(message) : null;
      ws.send(serverInfo ?? message);
    });
  });

  return {
    requestCount() {
      return requests;
    },
    releaseNextResponse() {
      const sendResponse = pendingResponses.shift();
      if (!sendResponse) {
        throw new Error("No deferred provider usage response is pending.");
      }
      sendResponse();
    },
    waitForRequestCount(count: number) {
      if (requests >= count) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        waiters.push({ count, resolve });
      });
    },
  };
}
