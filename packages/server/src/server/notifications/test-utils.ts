import pino from "pino";
import type { NotificationHttp } from "./notification-http.js";

export function createNotificationTestLogger() {
  const records: string[] = [];
  const logger = pino({}, { write: (line: string) => records.push(line) });
  return { logger, records };
}

export function createNotificationHttpFake(
  responses: Array<{ status?: number; body?: unknown; headers?: Record<string, string> } | Error>,
) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const request: NotificationHttp = async (url, init) => {
    requests.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("No fake HTTP response configured");
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status ?? 200,
      headers: next.headers,
    });
  };
  return { request, requests };
}
