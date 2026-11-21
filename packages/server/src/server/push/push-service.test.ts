import type pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import { PushService } from "./push-service.js";

function createLogger(): pino.Logger {
  const logger = {
    child: () => logger,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  return logger as unknown as pino.Logger;
}

describe("PushService", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("sends high priority so Android delivers while the device dozes", async () => {
    const requests: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        requests.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ data: [{ status: "ok", id: "ticket" }] }));
      }),
    );
    const service = new PushService(createLogger(), () => undefined);

    await service.sendPush(["ExponentPushToken[android-device]"], {
      title: "Agent finished",
      body: "Done",
    });

    expect(requests).toEqual([
      [expect.objectContaining({ to: "ExponentPushToken[android-device]", priority: "high" })],
    ]);
  });
});
