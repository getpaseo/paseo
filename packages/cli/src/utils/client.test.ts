import { describe, expect, it } from "vitest";
import { installBoundedWebSocketClose } from "./client";

class FakeCliWebSocket {
  readyState = 1;
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  terminateCalls = 0;
  private closeListeners: Array<() => void> = [];

  send(): void {}

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
  }

  terminate(): void {
    this.terminateCalls++;
  }

  once(event: "close", listener: () => void): void {
    if (event === "close") {
      this.closeListeners.push(listener);
    }
  }

  emitClose(): void {
    this.readyState = 3;
    for (const listener of this.closeListeners.splice(0)) {
      listener();
    }
  }
}

function createFakeTimers() {
  class FakeTimer {
    cleared = false;
    unrefCalls = 0;

    constructor(
      readonly callback: () => void,
      readonly delayMs: number,
    ) {}

    unref(): void {
      this.unrefCalls++;
    }
  }

  const scheduled: FakeTimer[] = [];

  const timers = {
    setTimeout(callback, delayMs) {
      const timer = new FakeTimer(callback, delayMs);
      scheduled.push(timer);
      return timer;
    },
    clearTimeout(timerHandle) {
      const timer = scheduled.find((entry) => entry === timerHandle);
      if (timer) {
        timer.cleared = true;
      }
    },
  } satisfies NonNullable<Parameters<typeof installBoundedWebSocketClose>[1]>;

  return { scheduled, timers };
}

describe("installBoundedWebSocketClose", () => {
  it("unrefs and terminates a socket whose close handshake does not complete", () => {
    const socket = new FakeCliWebSocket();
    const { scheduled, timers } = createFakeTimers();
    installBoundedWebSocketClose(socket, timers, 25);

    socket.close(1000, "command complete");

    expect(socket.closeCalls).toEqual([{ code: 1000, reason: "command complete" }]);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({ delayMs: 25, cleared: false, unrefCalls: 1 });

    scheduled[0]?.callback();

    expect(socket.terminateCalls).toBe(1);
  });

  it("cancels termination when graceful close completes first", () => {
    const socket = new FakeCliWebSocket();
    const { scheduled, timers } = createFakeTimers();
    installBoundedWebSocketClose(socket, timers, 25);

    socket.close();
    socket.emitClose();
    scheduled[0]?.callback();

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({ cleared: true, unrefCalls: 1 });
    expect(socket.terminateCalls).toBe(0);
  });
});
