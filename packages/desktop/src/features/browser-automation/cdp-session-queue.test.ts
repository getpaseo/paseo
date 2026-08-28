import { describe, expect, it } from "vitest";
import { CdpSessionQueue } from "./cdp-session-queue";

describe("CdpSessionQueue", () => {
  it("runs queued commands one at a time in order", async () => {
    const queue = new CdpSessionQueue();
    const order: string[] = [];
    const first = queue.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push("first");
      return 1;
    });
    const second = queue.run(async () => {
      order.push("second");
      return 2;
    });

    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(order).toEqual(["first", "second"]);
  });

  it("keeps the tab usable when a command never settles", async () => {
    // Without the bound this hangs forever: the stuck command holds the serial
    // queue and every later command on that webContents waits behind it.
    const queue = new CdpSessionQueue(20);

    await expect(queue.run(() => new Promise(() => {}))).rejects.toThrow(
      "CDP command timed out after 20ms",
    );
    await expect(queue.run(async () => "recovered")).resolves.toBe("recovered");
  });

  it("lets a later command run after one rejects", async () => {
    const queue = new CdpSessionQueue();

    await expect(queue.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(queue.run(async () => "next")).resolves.toBe("next");
  });
});
