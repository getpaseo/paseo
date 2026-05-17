import type pino from "pino";
import { describe, expect, test, vi } from "vitest";

import { ServerChanService } from "./serverchan-service.js";

function createLogger(): pino.Logger {
  const logger = {
    child: () => logger,
    warn: vi.fn(),
  };
  return logger as unknown as pino.Logger;
}

describe("ServerChanService", () => {
  test("skips sending when no send key is configured", async () => {
    const fetchImpl = vi.fn();
    const service = new ServerChanService(createLogger(), { sendKey: "", fetchImpl });

    await service.send({ title: "Agent finished", body: "Done." });

    expect(service.enabled).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("sends ServerChan form payload when configured", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const service = new ServerChanService(createLogger(), {
      sendKey: "SCT123",
      fetchImpl,
    });

    await service.send({ title: "Agent finished", body: "Done." });

    expect(service.enabled).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://sctapi.ftqq.com/SCT123.send");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    });
    expect(init.body).toBeInstanceOf(URLSearchParams);
    const body = init.body as URLSearchParams;
    expect(body.get("title")).toBe("Agent finished");
    expect(body.get("desp")).toBe("Done.");
    expect(body.get("short")).toBe("Done.");
  });

  test("logs and swallows ServerChan failures", async () => {
    const logger = createLogger();
    const fetchImpl = vi.fn(async () => new Response("bad", { status: 500 }));
    const service = new ServerChanService(logger, { sendKey: "SCT123", fetchImpl });

    await expect(service.send({ title: "Agent finished", body: "Done." })).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalled();
  });
});
