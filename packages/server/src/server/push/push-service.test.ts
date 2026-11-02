import pino from "pino";
import { describe, expect, test } from "vitest";

import { PushService } from "./push-service.js";

describe("PushService", () => {
  test("requests high priority for every notification across batches", async () => {
    const requests: Record<string, unknown>[][] = [];
    const sendRequest: typeof fetch = async (_url, init) => {
      const messages = JSON.parse(String(init?.body)) as Record<string, unknown>[];
      requests.push(messages);
      return new Response(
        JSON.stringify({ data: messages.map(() => ({ status: "ok", id: "ticket" })) }),
      );
    };
    const service = new PushService(pino({ level: "silent" }), () => undefined, sendRequest);
    const tokens = Array.from({ length: 101 }, (_, index) => `ExponentPushToken[device-${index}]`);

    await service.sendPush(tokens, {
      title: "Agent finished",
      body: "Done",
      data: { agentId: "agent" },
    });

    expect(requests.map((batch) => batch.length)).toEqual([100, 1]);
    expect(requests.flat()).toEqual(
      tokens.map((token) => ({
        to: token,
        priority: "high",
        title: "Agent finished",
        body: "Done",
        data: { agentId: "agent" },
        sound: "default",
      })),
    );
  });
});
