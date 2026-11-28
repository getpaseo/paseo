import { describe, expect, test, vi } from "vitest";
import {
  BROWSER_FOCUS_GUARD_EVENT,
  BROWSER_FOCUS_GUARD_READY_CHANNEL,
  guardHostPointerFocus,
} from "./focus-guard.js";

class FakeIpc {
  private readonly listeners = new Map<
    string,
    Set<(event: { sender: { id: number } }, payload: unknown) => void>
  >();

  public on(
    channel: string,
    listener: (event: { sender: { id: number } }, payload: unknown) => void,
  ): void {
    const set = this.listeners.get(channel) ?? new Set();
    set.add(listener);
    this.listeners.set(channel, set);
  }

  public removeListener(
    channel: string,
    listener: (event: { sender: { id: number } }, payload: unknown) => void,
  ): void {
    this.listeners.get(channel)?.delete(listener);
  }

  public emit(channel: string, senderId: number, payload: unknown): void {
    const listeners = this.listeners.get(channel);
    if (!listeners) {
      return;
    }
    for (const listener of Array.from(listeners)) {
      listener({ sender: { id: senderId } }, payload);
    }
  }

  public listenerCount(channel: string): number {
    return this.listeners.get(channel)?.size ?? 0;
  }
}

class FakeHost {
  public readonly sent: Array<{ channel: string; payload: unknown }> = [];
  public destroyed = false;
  private readonly destroyedListeners = new Set<() => void>();

  public constructor(public readonly id: number) {}

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload });
  }

  public once(_event: "destroyed", listener: () => void): void {
    this.destroyedListeners.add(listener);
  }

  public removeListener(_event: "destroyed", listener: () => void): void {
    this.destroyedListeners.delete(listener);
  }

  public destroy(): void {
    this.destroyed = true;
    for (const listener of Array.from(this.destroyedListeners)) {
      this.destroyedListeners.delete(listener);
      listener();
    }
  }
}

describe("guardHostPointerFocus", () => {
  test("handshakes with the matching host renderer and releases idempotently", async () => {
    const ipc = new FakeIpc();
    const host = new FakeHost(42);

    const pending = guardHostPointerFocus({
      hostContents: host,
      browserId: "browser-1",
      ipc,
    });

    expect(host.sent).toEqual([
      {
        channel: BROWSER_FOCUS_GUARD_EVENT,
        payload: { browserId: "browser-1", token: expect.any(String), active: true },
      },
    ]);
    const token = (host.sent[0]!.payload as { token: string }).token;

    // Ignore replies from another window or with a different token.
    ipc.emit(BROWSER_FOCUS_GUARD_READY_CHANNEL, 99, { token, composing: false });
    ipc.emit(BROWSER_FOCUS_GUARD_READY_CHANNEL, 42, { token: "wrong-token", composing: false });
    expect(ipc.listenerCount(BROWSER_FOCUS_GUARD_READY_CHANNEL)).toBe(1);

    ipc.emit(BROWSER_FOCUS_GUARD_READY_CHANNEL, 42, { token, composing: false });
    const result = await pending;
    expect(result.status).toBe("ready");
    expect(ipc.listenerCount(BROWSER_FOCUS_GUARD_READY_CHANNEL)).toBe(0);

    if (result.status !== "ready") {
      throw new Error("Expected ready focus guard");
    }
    result.release();
    result.release();
    expect(host.sent).toEqual([
      {
        channel: BROWSER_FOCUS_GUARD_EVENT,
        payload: { browserId: "browser-1", token, active: true },
      },
      {
        channel: BROWSER_FOCUS_GUARD_EVENT,
        payload: { browserId: "browser-1", token, active: false },
      },
    ]);
  });

  test("returns composing when the renderer reports active IME composition", async () => {
    const ipc = new FakeIpc();
    const host = new FakeHost(42);

    const pending = guardHostPointerFocus({
      hostContents: host,
      browserId: "browser-1",
      ipc,
    });
    const token = (host.sent[0]!.payload as { token: string }).token;
    ipc.emit(BROWSER_FOCUS_GUARD_READY_CHANNEL, 42, { token, composing: true });

    await expect(pending).resolves.toEqual({ status: "composing" });
    expect(ipc.listenerCount(BROWSER_FOCUS_GUARD_READY_CHANNEL)).toBe(0);
    // Renderer declined before acquiring a guard, so main does not need a release send.
    expect(host.sent).toHaveLength(1);
  });

  test("returns unavailable and cleans up if the renderer times out", async () => {
    vi.useFakeTimers();
    try {
      const ipc = new FakeIpc();
      const host = new FakeHost(42);

      const pending = guardHostPointerFocus({
        hostContents: host,
        browserId: "browser-1",
        ipc,
        timeoutMs: 200,
      });
      const token = (host.sent[0]!.payload as { token: string }).token;

      await vi.advanceTimersByTimeAsync(200);
      await expect(pending).resolves.toEqual({ status: "unavailable" });
      expect(ipc.listenerCount(BROWSER_FOCUS_GUARD_READY_CHANNEL)).toBe(0);
      expect(host.sent).toEqual([
        {
          channel: BROWSER_FOCUS_GUARD_EVENT,
          payload: { browserId: "browser-1", token, active: true },
        },
        {
          channel: BROWSER_FOCUS_GUARD_EVENT,
          payload: { browserId: "browser-1", token, active: false },
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("returns unavailable immediately when the host window closes mid-handshake", async () => {
    const ipc = new FakeIpc();
    const host = new FakeHost(42);

    const pending = guardHostPointerFocus({
      hostContents: host,
      browserId: "browser-1",
      ipc,
    });
    host.destroy();

    await expect(pending).resolves.toEqual({ status: "unavailable" });
    expect(ipc.listenerCount(BROWSER_FOCUS_GUARD_READY_CHANNEL)).toBe(0);
  });
});
