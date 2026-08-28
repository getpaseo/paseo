import { describe, expect, test } from "vitest";
import { TransferFlowControl } from "./transfer-flow-control.js";

describe("TransferFlowControl", () => {
  test("does not block while the transfer stays under its window", async () => {
    const flow = new TransferFlowControl(1000);
    flow.recordSent(999);
    await expect(flow.awaitWindow()).resolves.toBeUndefined();
  });

  test("parks the sender at the window and resumes on an ack", async () => {
    const flow = new TransferFlowControl(1000);
    flow.recordSent(1000);

    let resumed = false;
    const waiting = flow.awaitWindow().then(() => {
      resumed = true;
      return resumed;
    });

    await Promise.resolve();
    expect(resumed).toBe(false);

    flow.onAck(600);
    await waiting;
    expect(resumed).toBe(true);
  });

  test("ignores an ack that would walk the window backwards", async () => {
    const flow = new TransferFlowControl(1000);
    flow.recordSent(1000);
    flow.onAck(600);
    flow.onAck(200); // reordered or duplicated
    flow.recordSent(600); // 1600 sent, 600 acked -> 1000 outstanding, at the window

    let resumed = false;
    const waiting = flow.awaitWindow().then(() => {
      resumed = true;
      return resumed;
    });
    await Promise.resolve();
    expect(resumed).toBe(false);

    flow.onAck(1600);
    await waiting;
    expect(resumed).toBe(true);
  });

  test("releases a parked sender on cancel so a transfer cannot hang", async () => {
    const flow = new TransferFlowControl(1000);
    flow.recordSent(1000);
    const waiting = flow.awaitWindow();
    flow.cancel();
    await expect(waiting).resolves.toBeUndefined();
    expect(flow.isCancelled).toBe(true);
  });
});
