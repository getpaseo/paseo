import type pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createPushNotificationSender } from "./notifications.js";
import type { PushTokenStore } from "./token-store.js";

function createLogger(): pino.Logger {
  const logger = {
    child: () => logger,
    info: vi.fn(),
    warn: vi.fn(),
  };
  return logger as unknown as pino.Logger;
}

function createTokenStore(tokens: string[]): PushTokenStore {
  return {
    getAllTokens: () => tokens,
    removeToken: vi.fn(),
  } as unknown as PushTokenStore;
}

describe("createPushNotificationSender", () => {
  const originalSendKey = process.env["PASEO_SERVERCHAN_SENDKEY"];
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    if (originalSendKey === undefined) {
      delete process.env["PASEO_SERVERCHAN_SENDKEY"];
    } else {
      process.env["PASEO_SERVERCHAN_SENDKEY"] = originalSendKey;
    }
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test("sends ServerChan notification even when there are no Expo push tokens", async () => {
    process.env["PASEO_SERVERCHAN_SENDKEY"] = "SCT123";
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    const sender = createPushNotificationSender(createLogger(), createTokenStore([]));

    await sender.send({ title: "Agent finished", body: "Done." });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://sctapi.ftqq.com/SCT123.send");
    expect(init.body).toBeInstanceOf(URLSearchParams);
    expect((init.body as URLSearchParams).get("title")).toBe("Agent finished");
  });
});
