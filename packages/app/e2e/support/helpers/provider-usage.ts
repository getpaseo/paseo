import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import type { ProviderUsage } from "@getpaseo/protocol/messages";
import { gotoAppShell, openSettings } from "./app";
import { daemonWsRoutePattern } from "./daemon-port";
import { getServerId } from "./server-id";
import { openSettingsHostSection } from "./settings";

export interface ProviderUsageFixturePayload {
  fetchedAt: string;
  providers: ProviderUsage[];
}

export interface ProviderUsageFixture {
  requestCount(): number;
  waitForRequestCount(count: number): Promise<void>;
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

export async function installProviderUsageFixture(
  page: Page,
  payloads: ProviderUsageFixturePayload[],
): Promise<ProviderUsageFixture> {
  let requests = 0;
  const waiters: Array<{ count: number; resolve: () => void }> = [];

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

const SYNTHETIC_CARD = "provider-usage-card";
const SYNTHETIC_REQUEST_COUNTS = "0 / 750 requests";

// Synthetic's rolling 5-hour window carries a request-count detail and its weekly
// window reports a partial refill, so the fixture exercises both label shapes.
export function buildSyntheticUsageFixturePayload(now = Date.now()): ProviderUsageFixturePayload {
  return {
    fetchedAt: new Date(now).toISOString(),
    providers: [
      {
        providerId: "synthetic",
        displayName: "Synthetic",
        status: "available",
        planLabel: null,
        windows: [
          { id: "subscription", label: "5 hours", usedPct: 0, detail: SYNTHETIC_REQUEST_COUNTS },
          {
            id: "weekly",
            label: "Weekly",
            usedPct: 38,
            refillsAt: new Date(now + 3 * 60 * 60 * 1000).toISOString(),
          },
        ],
      },
    ],
  };
}

export function installSyntheticUsageFixture(page: Page): Promise<ProviderUsageFixture> {
  return installProviderUsageFixture(page, [buildSyntheticUsageFixturePayload()]);
}

export async function openProviderUsageSettings(page: Page): Promise<void> {
  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsHostSection(page, getServerId(), "usage");
}

export function providerUsageCard(page: Page): Locator {
  return page.getByTestId(SYNTHETIC_CARD);
}

export async function expectSyntheticUsageWindows(page: Page): Promise<void> {
  const card = providerUsageCard(page);
  await expect(card.getByText(SYNTHETIC_REQUEST_COUNTS, { exact: true })).toBeVisible();
  await expect(card.getByText(/next refill/)).toBeVisible();
  // The rolling window refills, it never fully resets, so no "resets" label.
  await expect(card.getByText(/resets/)).toHaveCount(0);
}

export async function expectRequestCountsAboveWeeklyWindow(page: Page): Promise<void> {
  const card = providerUsageCard(page);
  const countsTop = await textTop(card, SYNTHETIC_REQUEST_COUNTS);
  const weeklyTop = await textTop(card, "Weekly");
  expect(countsTop).toBeLessThan(weeklyTop);
}

export async function expectSyntheticUsageWindowsAtCompactWidth(page: Page): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
  await expectSyntheticUsageWindows(page);
}

export async function captureProviderUsageCard(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  await testInfo.attach(name, {
    body: await page.screenshot({ path: testInfo.outputPath(`${name}.png`) }),
    contentType: "image/png",
  });
}

// Reads a text node's top edge without `boundingBox()`'s nullable result.
function textTop(scope: Locator, text: string): Promise<number> {
  return scope
    .getByText(text, { exact: true })
    .evaluate((element) => element.getBoundingClientRect().y);
}
