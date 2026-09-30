import type { Page } from "@playwright/test";
import type { UsageReportEntry } from "@getpaseo/protocol/messages";
import { daemonWsRoutePattern } from "./daemon-port";

export interface UsageReportsFixture {
  listRequests(): Array<{ forceRefresh: boolean; reportIds?: string[] }>;
  waitForListRequests(count: number): Promise<void>;
}

interface UsageReportsFixtureOptions {
  /**
   * Successive `usage.list_reports` responses; the last one repeats. `{ error }` fails that
   * request; a function builds the response when the request arrives (e.g. a fresh `fetchedAt`).
   */
  lists?: Array<UsageListResponse | (() => UsageListResponse)>;
  /** False simulates a host with no usage reporting capability. */
  usageSupported?: boolean;
}

type UsageListResponse = UsageReportEntry[] | { error: string };

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
  const envelope = parseJson(message) as { type?: unknown; message?: unknown } | null;
  if (!envelope || envelope.type !== "session" || typeof envelope.message !== "object") {
    return null;
  }
  return envelope.message as Record<string, unknown>;
}

function withUsageSupportFeature(message: WebSocketMessage, enabled: boolean): string | null {
  const envelope = parseJson(message) as {
    type?: unknown;
    message?: { type?: unknown; payload?: Record<string, unknown> };
  } | null;
  const payload = envelope?.message?.payload;
  if (
    envelope?.type !== "session" ||
    envelope.message?.type !== "status" ||
    payload?.status !== "server_info"
  ) {
    return null;
  }
  const features =
    typeof payload.features === "object" && payload.features !== null ? payload.features : {};
  return JSON.stringify({
    ...envelope,
    message: {
      ...envelope.message,
      payload: {
        ...payload,
        features: { ...features, usageSources: enabled, providerUsageList: enabled },
      },
    },
  });
}

function pick<T>(values: T[], index: number): T {
  const value = values[Math.min(index, values.length - 1)];
  if (value === undefined) throw new Error("Usage fixture requires at least one response.");
  return value;
}

function createCounter() {
  let count = 0;
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  return {
    increment() {
      count += 1;
      for (const waiter of waiters.splice(0)) {
        if (count >= waiter.count) waiter.resolve();
        else waiters.push(waiter);
      }
    },
    waitFor(target: number): Promise<void> {
      if (count >= target) return Promise.resolve();
      return new Promise((resolve) => waiters.push({ count: target, resolve }));
    },
  };
}

export async function installUsageReportsFixture(
  page: Page,
  options: UsageReportsFixtureOptions,
): Promise<UsageReportsFixture> {
  const listRequests: Array<{ forceRefresh: boolean; reportIds?: string[] }> = [];
  const listCounter = createCounter();
  const usageSupported = options.usageSupported ?? true;

  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();

    ws.onMessage((message) => {
      const request = getSessionMessage(message);
      const requestId = request?.requestId;
      if (request?.type === "usage.list_reports.request" && typeof requestId === "string") {
        listRequests.push({
          forceRefresh: request.forceRefresh === true,
          reportIds: Array.isArray(request.reportIds) ? (request.reportIds as string[]) : undefined,
        });
        const scripted = pick(options.lists ?? [[]], listRequests.length - 1);
        const response = typeof scripted === "function" ? scripted() : scripted;
        if ("error" in response) {
          ws.send(
            JSON.stringify({
              type: "session",
              message: {
                type: "rpc_error",
                payload: {
                  requestId,
                  requestType: "usage.list_reports.request",
                  error: response.error,
                  code: "transport",
                },
              },
            }),
          );
          listCounter.increment();
          return;
        }
        const ids = Array.isArray(request.reportIds) ? request.reportIds : null;
        const reports = ids ? response.filter((entry) => ids.includes(entry.id)) : response;
        ws.send(
          JSON.stringify({
            type: "session",
            message: { type: "usage.list_reports.response", payload: { requestId, reports } },
          }),
        );
        listCounter.increment();
        return;
      }
      server.send(message);
    });

    server.onMessage((message) => {
      const serverInfo =
        typeof message === "string" ? withUsageSupportFeature(message, usageSupported) : null;
      ws.send(serverInfo ?? message);
    });
  });

  return {
    listRequests: () => [...listRequests],
    waitForListRequests: (count) => listCounter.waitFor(count),
  };
}
