import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { DeliveryQueue } from "./delivery-queue.js";
import { DeliveryError } from "./notification-http.js";
import { createNotificationTestLogger } from "./test-utils.js";

describe("durable provider delivery queue", () => {
  const homes: string[] = [];
  function filePath() {
    const home = mkdtempSync(join(tmpdir(), "paseo-delivery-"));
    homes.push(home);
    return join(home, "queue.json");
  }
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  it("retries with bounded exponential backoff and persists across restart", async () => {
    const file = filePath();
    let now = 0;
    let attempts = 0;
    const { logger, records } = createNotificationTestLogger();
    const options = {
      filePath: file,
      schema: z.string(),
      logger,
      now: () => now,
      random: () => 0.5,
      automatic: false,
      deliver: async () => {
        attempts++;
        throw new DeliveryError("network", true);
      },
    };
    const first = new DeliveryQueue(options);
    await first.enqueue("server-a:event-a", "message");
    expect(attempts).toBe(1);
    expect(JSON.parse(readFileSync(file, "utf8"))[0].dueAt).toBe(1500);
    await first.close();
    const restarted = new DeliveryQueue(options);
    await restarted.drain();
    expect(attempts).toBe(1);
    for (const delay of [1500, 3000, 6000, 12000]) {
      now += delay;
      await restarted.drain();
    }
    expect(attempts).toBe(5);
    now += 100_000;
    await restarted.drain();
    expect(attempts).toBe(5);
    expect(records.join("\n")).toContain("Notification permanent delivery failure");
    await restarted.close();
  });
  it("deduplicates retransmissions across restarts without merging agents or servers", async () => {
    const file = filePath();
    let now = 0;
    const sent: string[] = [];
    const options = {
      filePath: file,
      schema: z.string(),
      logger: createNotificationTestLogger().logger,
      automatic: false,
      now: () => now,
      deliver: async (_payload: string, id: string) => {
        sent.push(id);
      },
    };
    const queue = new DeliveryQueue(options);
    await queue.enqueue("s1:a1:e1", "one");
    await queue.enqueue("s1:a1:e1", "one");
    await queue.close();
    const restarted = new DeliveryQueue(options);
    await restarted.enqueue("s1:a1:e1", "one");
    await restarted.enqueue("s1:a2:e1", "two");
    await restarted.enqueue("s2:a1:e1", "three");
    now += 200;
    await restarted.drain();
    expect(sent).toEqual(["s1:a1:e1", "s1:a2:e1", "s2:a1:e1"]);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    await restarted.close();
  });
  it("respects Retry-After and never retries permanent authentication failures", async () => {
    const file = filePath();
    let now = 0;
    let attempts = 0;
    const queue = new DeliveryQueue({
      filePath: file,
      schema: z.string(),
      logger: createNotificationTestLogger().logger,
      automatic: false,
      now: () => now,
      deliver: async () => {
        attempts++;
        throw attempts === 1
          ? new DeliveryError("http", true, 30_000, 429)
          : new DeliveryError("authentication", false, 0, 403);
      },
    });
    await queue.enqueue("e1", "message");
    now = 29_999;
    await queue.drain();
    expect(attempts).toBe(1);
    now = 30_000;
    await queue.drain();
    now = 90_000;
    await queue.drain();
    expect(attempts).toBe(2);
    await queue.close();
  });
  it("expires pending jobs even when Retry-After exceeds the event lifetime", async () => {
    let now = 0;
    let attempts = 0;
    const { logger, records } = createNotificationTestLogger();
    const queue = new DeliveryQueue({
      filePath: filePath(),
      schema: z.string(),
      logger,
      automatic: false,
      now: () => now,
      deliver: async () => {
        attempts++;
        throw new DeliveryError("http", true, 3 * 24 * 60 * 60 * 1000, 429);
      },
    });
    await queue.enqueue("event", "message");
    now = 24 * 60 * 60 * 1000;
    await queue.drain();
    expect(attempts).toBe(1);
    expect(records.join("\n")).toContain('"category":"expired"');
    await queue.close();
  });
  it("bounds pending jobs and reports capacity errors", async () => {
    const queue = new DeliveryQueue({
      filePath: filePath(),
      schema: z.string(),
      logger: createNotificationTestLogger().logger,
      automatic: false,
      now: () => 0,
      deliver: async () => {
        throw new DeliveryError("network", true);
      },
    });
    for (let id = 0; id < 1024; id++) await queue.enqueue(String(id), "pending");
    await expect(queue.enqueue("overflow", "pending")).rejects.toThrow("queue_full");
    await queue.close();
  });
});
