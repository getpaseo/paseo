import { EnvHttpProxyAgent, fetch } from "undici";

export class DeliveryError extends Error {
  constructor(
    public readonly category: string,
    public readonly retryable: boolean,
    public readonly retryAfterMs = 0,
    public readonly status?: number,
  ) {
    super(`Notification delivery failed: ${category}`);
  }
}

export type NotificationHttp = (
  url: string,
  init: RequestInit,
) => Promise<Pick<Response, "status" | "headers" | "json" | "text">>;

export function createNotificationHttp(env: NodeJS.ProcessEnv = process.env): {
  request: NotificationHttp;
  close(): Promise<void>;
} {
  const dispatcher = new EnvHttpProxyAgent({
    httpProxy: env.http_proxy ?? env.HTTP_PROXY ?? "",
    httpsProxy: env.https_proxy ?? env.HTTPS_PROXY ?? "",
    noProxy: env.no_proxy ?? env.NO_PROXY ?? "",
  });
  return {
    request: (url, init) =>
      fetch(url, {
        method: init.method,
        headers: init.headers as Record<string, string>,
        body: init.body as string,
        signal: init.signal,
        redirect: "error",
        dispatcher,
      }),
    close: () => dispatcher.close(),
  };
}

export async function postNotification(
  http: NotificationHttp,
  url: string,
  body: unknown,
  headers: Record<string, string>,
  now: () => number = Date.now,
): Promise<unknown> {
  try {
    const response = await http(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (response.status < 200 || response.status >= 300) {
      const retryAfter = response.headers.get("retry-after");
      const seconds = retryAfter === null ? NaN : Number(retryAfter);
      const delay = Number.isFinite(seconds)
        ? seconds * 1000
        : Date.parse(retryAfter ?? "") - now();
      await response.text();
      throw new DeliveryError(
        response.status === 401 || response.status === 403 ? "authentication" : "http",
        response.status === 429 || response.status >= 500,
        Math.max(0, Number.isFinite(delay) ? delay : 0),
        response.status,
      );
    }
    try {
      return await response.json();
    } catch (error) {
      if (error instanceof SyntaxError) throw new DeliveryError("invalid_response", false);
      throw error;
    }
  } catch (error) {
    if (error instanceof DeliveryError) throw error;
    // Transport errors can embed URLs, credentials and request bodies.
    throw new DeliveryError("network_or_timeout", true);
  }
}
