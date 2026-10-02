import type { Page } from "@playwright/test";
import type { UsageReportEntry } from "@getpaseo/protocol/messages";
import { daemonWsRoutePattern, wsRoutePatternForPort } from "./daemon-port";

export interface UsageListRequest {
  forceRefresh: boolean;
  reportIds?: string[];
}

export interface UsageReportsFixture {
  listRequests(): UsageListRequest[];
  waitForListRequests(count: number): Promise<void>;
}

interface UsageReportsFixtureOptions {
  /**
   * Successive `usage.list_reports` responses; the last one repeats. `{ error }` fails that
   * request; a function builds the response from the request when it arrives (e.g. a fresh
   * `fetchedAt`, or a different answer to a forced refresh).
   */
  lists?: Array<UsageListResponse | ((request: UsageListRequest) => UsageListResponse)>;
  /** False simulates a host with no usage reporting capability. */
  usageSupported?: boolean;
  /** Released hosts expose provider.usage.list with no source icons. */
  providerUsageListOnly?: boolean;
  /** The host daemon's port; defaults to the E2E daemon. */
  port?: number;
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

function withUsageSupportFeature(
  message: WebSocketMessage,
  enabled: boolean,
  providerUsageListOnly: boolean,
): string | null {
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
        features: {
          ...features,
          usageSources: enabled && !providerUsageListOnly,
          providerUsageList: enabled,
        },
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
  const listRequests: UsageListRequest[] = [];
  const listCounter = createCounter();
  const usageSupported = options.usageSupported ?? true;
  const providerUsageListOnly = options.providerUsageListOnly ?? false;
  const requestType = providerUsageListOnly
    ? "provider.usage.list.request"
    : "usage.list_reports.request";

  const route =
    options.port === undefined ? daemonWsRoutePattern() : wsRoutePatternForPort(`${options.port}`);
  await page.routeWebSocket(route, (ws) => {
    const server = ws.connectToServer();

    ws.onMessage((message) => {
      const request = getSessionMessage(message);
      const requestId = request?.requestId;
      if (request?.type === requestType && typeof requestId === "string") {
        const listRequest: UsageListRequest = {
          forceRefresh: request.forceRefresh === true,
          reportIds: Array.isArray(request.reportIds) ? (request.reportIds as string[]) : undefined,
        };
        listRequests.push(listRequest);
        const scripted = pick(options.lists ?? [[]], listRequests.length - 1);
        const response = typeof scripted === "function" ? scripted(listRequest) : scripted;
        if ("error" in response) {
          ws.send(
            JSON.stringify({
              type: "session",
              message: {
                type: "rpc_error",
                payload: {
                  requestId,
                  requestType,
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
        const reply = providerUsageListOnly
          ? {
              type: "provider.usage.list.response",
              payload: {
                requestId,
                fetchedAt: new Date().toISOString(),
                providers: reports.map((entry) => ({
                  providerId: entry.sourceId,
                  displayName: entry.sourceLabel,
                  fetchedAt: entry.fetchedAt,
                  status: entry.report.status,
                  windows: entry.report.status === "available" ? entry.report.windows : [],
                  balances: entry.report.status === "available" ? entry.report.balances : undefined,
                  details: entry.report.status === "available" ? entry.report.details : undefined,
                  planLabel:
                    entry.report.status === "available" ? (entry.report.planLabel ?? null) : null,
                  error: entry.report.status === "error" ? entry.report.error : null,
                })),
              },
            }
          : { type: "usage.list_reports.response", payload: { requestId, reports } };
        ws.send(JSON.stringify({ type: "session", message: reply }));
        listCounter.increment();
        return;
      }
      server.send(message);
    });

    server.onMessage((message) => {
      const serverInfo =
        typeof message === "string"
          ? withUsageSupportFeature(message, usageSupported, providerUsageListOnly)
          : null;
      ws.send(serverInfo ?? message);
    });
  });

  return {
    listRequests: () => [...listRequests],
    waitForListRequests: (count) => listCounter.waitFor(count),
  };
}
