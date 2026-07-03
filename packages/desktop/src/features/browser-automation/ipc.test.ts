import type { Rectangle } from "electron";
import { describe, expect, test, vi } from "vitest";
import type { TabImage } from "./service.js";
import { adaptWebContents } from "./ipc.js";

class FakeImage implements TabImage {
  public toPNG(): Uint8Array {
    return new Uint8Array([137, 80, 78, 71]);
  }

  public getSize(): { width: number; height: number } {
    return { width: 640, height: 480 };
  }
}

class FakeDebugger {
  public isAttached(): boolean {
    return false;
  }

  public attach(): void {}

  public async sendCommand(): Promise<unknown> {
    return {};
  }
}

class FakeHostWebContents {
  public readonly sentMessages: Array<{ channel: string; payload: unknown }> = [];
  public destroyed = false;

  public constructor(public readonly id: number) {}

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public send(channel: string, payload: unknown): void {
    this.sentMessages.push({ channel, payload });
  }
}

interface FakeIpcEvent {
  sender: {
    id: number;
  };
}

type IpcListener = (event: FakeIpcEvent, payload: unknown) => void;

class FakeIpcBridge {
  private readonly listeners = new Map<string, IpcListener[]>();

  public on(channel: string, listener: IpcListener): void {
    const listeners = this.listeners.get(channel) ?? [];
    listeners.push(listener);
    this.listeners.set(channel, listeners);
  }

  public removeListener(channel: string, listener: IpcListener): void {
    const listeners = this.listeners.get(channel) ?? [];
    this.listeners.set(
      channel,
      listeners.filter((candidate) => candidate !== listener),
    );
  }

  public emit(channel: string, payload: unknown, input: { senderId?: number } = {}): void {
    const event = { sender: { id: input.senderId ?? 10 } };
    for (const listener of this.listeners.get(channel) ?? []) {
      listener(event, payload);
    }
  }

  public listenerCount(channel: string): number {
    return this.listeners.get(channel)?.length ?? 0;
  }
}

class FakeWebContents {
  public readonly debugger = new FakeDebugger();
  public readonly consoleMessages: unknown[] = [];
  public readonly destroyedListeners: Array<() => void> = [];
  public destroyed = false;

  public constructor(
    public readonly id: number,
    public hostWebContents: FakeHostWebContents | null,
  ) {}

  public getURL(): string {
    return "https://example.com";
  }

  public getTitle(): string {
    return "Example";
  }

  public canGoBack(): boolean {
    return false;
  }

  public canGoForward(): boolean {
    return false;
  }

  public isLoading(): boolean {
    return false;
  }

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public async executeJavaScript(): Promise<unknown> {
    return null;
  }

  public async loadURL(): Promise<void> {}

  public goBack(): void {}

  public goForward(): void {}

  public reload(): void {}

  public async capturePage(
    _rect?: Rectangle,
    _options?: { stayHidden?: boolean },
  ): Promise<TabImage> {
    return new FakeImage();
  }

  public invalidate(): void {}

  public getBackgroundThrottling(): boolean {
    return true;
  }

  public setBackgroundThrottling(): void {}

  public on(
    event: "console-message",
    listener: (
      event: unknown,
      level: unknown,
      message: unknown,
      line: unknown,
      sourceId: unknown,
    ) => void,
  ): void {
    this.consoleMessages.push({ event, listener });
  }

  public once(event: "destroyed", listener: () => void): void {
    expect(event).toBe("destroyed");
    this.destroyedListeners.push(listener);
  }
}

describe("browser automation IPC adapter", () => {
  test("prepareForPixelCapture asks the embedder renderer and resolves the ack token", async () => {
    const host = new FakeHostWebContents(10);
    const contents = new FakeWebContents(20, host);
    const ipc = new FakeIpcBridge();
    const tab = adaptWebContents(contents, "browser-a", {
      ipc,
      createRequestId: () => "prepare-1",
    });

    const preparation = tab.prepareForPixelCapture();

    expect(host.sentMessages).toEqual([
      {
        channel: "paseo:browser:capture-prepare",
        payload: { requestId: "prepare-1", browserId: "browser-a" },
      },
    ]);
    ipc.emit("paseo:browser:capture-prepared", {
      requestId: "other",
      ok: true,
      token: "wrong-token",
    });
    expect(ipc.listenerCount("paseo:browser:capture-prepared")).toBe(1);

    ipc.emit("paseo:browser:capture-prepared", {
      requestId: "prepare-1",
      ok: true,
      token: "token-a",
    });

    await expect(preparation).resolves.toEqual({ token: "token-a" });
    expect(ipc.listenerCount("paseo:browser:capture-prepared")).toBe(0);
  });

  test("restorePixelCapture sends the capture token back to the embedder renderer", async () => {
    const host = new FakeHostWebContents(10);
    const contents = new FakeWebContents(20, host);
    const ipc = new FakeIpcBridge();
    const requestIds = ["prepare-1", "restore-1"];
    const tab = adaptWebContents(contents, "browser-a", {
      ipc,
      createRequestId: () => {
        const requestId = requestIds.shift();
        if (!requestId) {
          throw new Error("Missing request id");
        }
        return requestId;
      },
    });

    const preparation = tab.prepareForPixelCapture();
    ipc.emit("paseo:browser:capture-prepared", {
      requestId: "prepare-1",
      ok: true,
      token: "token-a",
    });
    await expect(preparation).resolves.toEqual({ token: "token-a" });

    const restored = tab.restorePixelCapture({ token: "token-a" });

    expect(host.sentMessages).toEqual([
      {
        channel: "paseo:browser:capture-prepare",
        payload: { requestId: "prepare-1", browserId: "browser-a" },
      },
      {
        channel: "paseo:browser:capture-restore",
        payload: { requestId: "restore-1", browserId: "browser-a", token: "token-a" },
      },
    ]);
    ipc.emit("paseo:browser:capture-restored", { requestId: "restore-1", ok: true });

    await expect(restored).resolves.toBeUndefined();
  });

  test("restorePixelCapture uses the host captured during preparation when the guest detaches", async () => {
    const host = new FakeHostWebContents(10);
    const contents = new FakeWebContents(20, host);
    const ipc = new FakeIpcBridge();
    const requestIds = ["prepare-1", "restore-1"];
    const tab = adaptWebContents(contents, "browser-a", {
      ipc,
      createRequestId: () => {
        const requestId = requestIds.shift();
        if (!requestId) {
          throw new Error("Missing request id");
        }
        return requestId;
      },
    });

    const preparationPromise = tab.prepareForPixelCapture();
    ipc.emit("paseo:browser:capture-prepared", {
      requestId: "prepare-1",
      ok: true,
      token: "token-a",
    });
    const preparation = await preparationPromise;
    contents.hostWebContents = null;

    const restored = tab.restorePixelCapture(preparation);

    expect(host.sentMessages).toEqual([
      {
        channel: "paseo:browser:capture-prepare",
        payload: { requestId: "prepare-1", browserId: "browser-a" },
      },
      {
        channel: "paseo:browser:capture-restore",
        payload: { requestId: "restore-1", browserId: "browser-a", token: "token-a" },
      },
    ]);
    ipc.emit("paseo:browser:capture-restored", { requestId: "restore-1", ok: true });

    await expect(restored).resolves.toBeUndefined();
    await expect(tab.restorePixelCapture(preparation)).rejects.toThrow(
      "Browser pixel capture preparation is no longer active.",
    );
  });

  test("prepareForPixelCapture rejects when the renderer reports preparation failure", async () => {
    const host = new FakeHostWebContents(10);
    const contents = new FakeWebContents(20, host);
    const ipc = new FakeIpcBridge();
    const tab = adaptWebContents(contents, "browser-a", {
      ipc,
      createRequestId: () => "prepare-1",
    });

    const preparation = tab.prepareForPixelCapture();
    ipc.emit("paseo:browser:capture-prepared", {
      requestId: "prepare-1",
      ok: false,
      message: "renderer could not prep",
    });

    await expect(preparation).rejects.toThrow("renderer could not prep");
    expect(ipc.listenerCount("paseo:browser:capture-prepared")).toBe(0);
  });

  test("prepareForPixelCapture ignores matching responses from the wrong sender", async () => {
    const host = new FakeHostWebContents(10);
    const contents = new FakeWebContents(20, host);
    const ipc = new FakeIpcBridge();
    const tab = adaptWebContents(contents, "browser-a", {
      ipc,
      createRequestId: () => "prepare-1",
    });

    const preparation = tab.prepareForPixelCapture();
    ipc.emit(
      "paseo:browser:capture-prepared",
      {
        requestId: "prepare-1",
        ok: true,
        token: "spoofed-token",
      },
      { senderId: 99 },
    );
    expect(ipc.listenerCount("paseo:browser:capture-prepared")).toBe(1);

    ipc.emit("paseo:browser:capture-prepared", {
      requestId: "prepare-1",
      ok: true,
      token: "token-a",
    });

    await expect(preparation).resolves.toEqual({ token: "token-a" });
  });

  test("prepareForPixelCapture cancels the renderer request when the ack times out", async () => {
    vi.useFakeTimers();
    try {
      const host = new FakeHostWebContents(10);
      const contents = new FakeWebContents(20, host);
      const ipc = new FakeIpcBridge();
      const tab = adaptWebContents(contents, "browser-a", {
        ipc,
        createRequestId: () => "prepare-1",
        timeoutMs: 25,
      });

      const preparation = tab.prepareForPixelCapture();
      const rejection = expect(preparation).rejects.toThrow(
        "Browser pixel capture prepare timed out.",
      );
      await vi.advanceTimersByTimeAsync(25);

      await rejection;
      expect(host.sentMessages).toEqual([
        {
          channel: "paseo:browser:capture-prepare",
          payload: { requestId: "prepare-1", browserId: "browser-a" },
        },
        {
          channel: "paseo:browser:capture-cancel",
          payload: { requestId: "prepare-1", browserId: "browser-a" },
        },
      ]);
      expect(ipc.listenerCount("paseo:browser:capture-prepared")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("prepareForPixelCapture rejects when the guest has no embedder renderer", async () => {
    const contents = new FakeWebContents(20, null);
    const tab = adaptWebContents(contents, "browser-a");

    await expect(tab.prepareForPixelCapture()).rejects.toThrow(
      "Browser host renderer is not available.",
    );
  });
});
