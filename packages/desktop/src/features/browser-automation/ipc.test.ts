import type { Rectangle } from "electron";
import { describe, expect, test, vi } from "vitest";
import type { TabImage } from "./service.js";
import { adaptWebContents, HostSnapshotEngineRegistry } from "./ipc.js";
import type { IsolatedKeyboardInputEvent } from "./trusted-input.js";

class FakeImage implements TabImage {
  public toPNG(): Uint8Array {
    return new Uint8Array([137, 80, 78, 71]);
  }

  public getSize(): { width: number; height: number } {
    return { width: 640, height: 480 };
  }
}

class FakeDebugger {
  public attachedProtocolVersions: string[] = [];
  public commands: Array<{ command: string; params: Record<string, unknown> }> = [];
  public blockCommands = false;
  public readonly blockedCommandNames = new Set<string>();
  public readonly failedCommandNames = new Set<string>();
  public readonly promptDialogs: unknown[] = [];
  public failPromptDrain = false;
  private messageListener:
    | ((event: unknown, method: string, params?: Record<string, unknown>) => void)
    | null = null;
  private readonly blockedCommands: Array<() => void> = [];

  public isAttached(): boolean {
    return this.attachedProtocolVersions.length > 0;
  }

  public attach(protocolVersion?: string): void {
    this.attachedProtocolVersions.push(protocolVersion ?? "");
  }

  public async sendCommand(command: string, params?: Record<string, unknown>): Promise<unknown> {
    this.commands.push({ command, params: params ?? {} });
    if (this.failedCommandNames.has(command)) {
      throw new Error(`${command} failed`);
    }
    if (this.blockCommands || this.blockedCommandNames.has(command)) {
      await new Promise<void>((resolve) => {
        this.blockedCommands.push(resolve);
      });
    }
    if (command === "Runtime.evaluate" && typeof params?.expression === "string") {
      if (params.expression.includes("state.prompts.splice(0)")) {
        if (this.failPromptDrain) {
          throw new Error("execution context destroyed");
        }
        return { result: { value: this.promptDialogs.splice(0) } };
      }
      return { result: { value: true } };
    }
    return { ok: true };
  }

  public on(
    event: "message",
    listener: (event: unknown, method: string, params?: Record<string, unknown>) => void,
  ): void {
    expect(event).toBe("message");
    this.messageListener = listener;
  }

  public emitMessage(method: string, params?: Record<string, unknown>): void {
    if (!this.messageListener) {
      throw new Error("Debugger message listener was not registered");
    }
    this.messageListener({}, method, params);
  }

  public finishNextCommand(): void {
    const resolve = this.blockedCommands.shift();
    if (!resolve) {
      throw new Error("No command is blocked");
    }
    resolve();
  }
}

type ConsoleMessageListener = (
  event: unknown,
  level: unknown,
  message: unknown,
  line: unknown,
  sourceId: unknown,
) => void;

class FakeWebContents {
  public readonly debugger = new FakeDebugger();
  public readonly inputEvents: IsolatedKeyboardInputEvent[] = [];
  public readonly captures: Array<{
    rect: Rectangle | undefined;
    options: { stayHidden?: boolean } | undefined;
  }> = [];
  public readonly invalidations: string[] = [];
  private consoleMessageListener: ConsoleMessageListener | null = null;
  private destroyedListener: (() => void) | null = null;
  public destroyed = false;

  public constructor(private readonly webContentsId: number) {}

  public get id(): number {
    if (this.destroyed) {
      throw new TypeError("Object has been destroyed");
    }
    return this.webContentsId;
  }

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
    rect?: Rectangle,
    options?: { stayHidden?: boolean },
  ): Promise<TabImage> {
    this.captures.push({ rect, options });
    return new FakeImage();
  }

  public invalidate(): void {
    this.invalidations.push("invalidate");
  }

  public sendInputEvent(event: IsolatedKeyboardInputEvent): void {
    this.inputEvents.push(event);
  }

  public on(event: "console-message", listener: ConsoleMessageListener): void {
    expect(event).toBe("console-message");
    this.consoleMessageListener = listener;
  }

  public once(event: "destroyed", listener: () => void): void {
    expect(event).toBe("destroyed");
    this.destroyedListener = listener;
  }

  public emitConsoleMessage(input: {
    level: unknown;
    message: unknown;
    line: unknown;
    sourceId: unknown;
  }): void {
    if (!this.consoleMessageListener) {
      throw new Error("Console listener was not registered");
    }
    this.consoleMessageListener({}, input.level, input.message, input.line, input.sourceId);
  }

  public destroy(): void {
    this.destroyed = true;
    this.destroyedListener?.();
  }
}

describe("browser automation IPC adapter", () => {
  test("isolates snapshot refs by host window and releases them on destruction", () => {
    const registry = new HostSnapshotEngineRegistry();
    const firstHost = new FakeHostWebContents(1);
    const secondHost = new FakeHostWebContents(2);

    const firstEngine = registry.get(firstHost);
    expect(registry.get(firstHost)).toBe(firstEngine);
    expect(registry.get(secondHost)).not.toBe(firstEngine);

    firstHost.destroy();
    expect(registry.get(new FakeHostWebContents(1))).not.toBe(firstEngine);
  });

  test("sends contained keyboard input directly to the guest", () => {
    const contents = new FakeWebContents(19);
    const tab = adaptWebContents(contents);

    tab.sendInputEvent({ type: "keyDown", keyCode: "Enter", skipIfUnhandled: true });

    expect(contents.inputEvents).toEqual([
      { type: "keyDown", keyCode: "Enter", skipIfUnhandled: true },
    ]);
  });

  test("delegates viewport capture to the guest without a renderer prep bridge", async () => {
    const contents = new FakeWebContents(20);
    const tab = adaptWebContents(contents);

    const image = await tab.capturePage({ stayHidden: false });
    tab.invalidate();

    expect(image.getSize()).toEqual({ width: 640, height: 480 });
    expect(contents.captures).toEqual([{ rect: undefined, options: { stayHidden: false } }]);
    expect(contents.invalidations).toEqual(["invalidate"]);
  });

  test("collects console messages until the guest is destroyed", () => {
    const contents = new FakeWebContents(21);
    const tab = adaptWebContents(contents);

    contents.emitConsoleMessage({
      level: "warning",
      message: "hello",
      line: 12,
      sourceId: "https://example.com/app.js",
    });

    expect(tab.getConsoleMessages?.()).toEqual([
      {
        level: "warning",
        message: "hello",
        line: 12,
        source: "https://example.com/app.js",
        timestamp: expect.any(Number),
      },
    ]);

    expect(() => contents.destroy()).not.toThrow();

    expect(tab.getConsoleMessages?.()).toEqual([]);
  });

  test("attaches the debugger before sending a CDP command", async () => {
    const contents = new FakeWebContents(22);
    const tab = adaptWebContents(contents);

    const result = await tab.sendDebugCommand?.("Page.captureScreenshot", {
      format: "png",
    });

    expect(result).toEqual({ ok: true });
    expect(contents.debugger.attachedProtocolVersions).toEqual(["1.3"]);
    expect(contents.debugger.commands).toEqual([
      { command: "Page.captureScreenshot", params: { format: "png" } },
    ]);
  });

  test("serializes CDP commands per guest contents", async () => {
    const contents = new FakeWebContents(23);
    contents.debugger.blockCommands = true;
    const tab = adaptWebContents(contents);

    const first = tab.sendDebugCommand?.("Input.dispatchMouseEvent", { type: "mouseMoved" });
    const second = tab.sendDebugCommand?.("Page.captureScreenshot", { format: "png" });
    await flushMicrotasks();

    expect(contents.debugger.commands).toEqual([
      { command: "Input.dispatchMouseEvent", params: { type: "mouseMoved" } },
    ]);

    contents.debugger.finishNextCommand();
    await flushMicrotasks();

    expect(contents.debugger.commands).toEqual([
      { command: "Input.dispatchMouseEvent", params: { type: "mouseMoved" } },
      { command: "Page.captureScreenshot", params: { format: "png" } },
    ]);

    contents.debugger.finishNextCommand();
    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).resolves.toEqual({ ok: true });
  });

  test("handles JavaScript dialogs through the per-tab CDP queue", async () => {
    const contents = new FakeWebContents(24);
    const tab = adaptWebContents(contents);

    const captured = tab.captureDialogs?.(async () => {
      contents.debugger.blockCommands = true;
      const input = tab.sendDebugCommand?.("Input.dispatchMouseEvent", { type: "mouseReleased" });
      await flushMicrotasks();

      contents.debugger.emitMessage("Page.javascriptDialogOpening", {
        type: "confirm",
        message: "Delete item?",
      });
      await flushMicrotasks();

      expect(contents.debugger.commands).toEqual([
        { command: "Page.enable", params: {} },
        {
          command: "Runtime.evaluate",
          params: { expression: expect.any(String), returnByValue: true },
        },
        { command: "Input.dispatchMouseEvent", params: { type: "mouseReleased" } },
        { command: "Page.handleJavaScriptDialog", params: { accept: false } },
      ]);

      contents.debugger.blockCommands = false;
      contents.debugger.finishNextCommand();
      await input;
      await flushMicrotasks();
      return "done";
    });

    await expect(captured).resolves.toEqual({
      result: "done",
      dialogs: [
        {
          type: "confirm",
          message: "Delete item?",
          action: "dismissed",
          timestamp: expect.any(Number),
        },
      ],
    });
    expect(contents.debugger.commands).toEqual([
      { command: "Page.enable", params: {} },
      {
        command: "Runtime.evaluate",
        params: { expression: expect.any(String), returnByValue: true },
      },
      { command: "Input.dispatchMouseEvent", params: { type: "mouseReleased" } },
      { command: "Page.handleJavaScriptDialog", params: { accept: false } },
      {
        command: "Runtime.evaluate",
        params: { expression: expect.any(String), returnByValue: true },
      },
      {
        command: "Runtime.evaluate",
        params: { expression: expect.any(String), returnByValue: true },
      },
    ]);
  });

  test("handles JavaScript dialogs while the triggering CDP input command is still in flight", async () => {
    const contents = new FakeWebContents(25);
    const tab = adaptWebContents(contents);

    const captured = tab.captureDialogs?.(async () => {
      contents.debugger.blockedCommandNames.add("Input.dispatchMouseEvent");
      const input = tab.sendDebugCommand?.("Input.dispatchMouseEvent", { type: "mousePressed" });
      await flushMicrotasks();

      contents.debugger.emitMessage("Page.javascriptDialogOpening", {
        type: "alert",
        message: "Saved",
      });
      await flushMicrotasks();

      expect(contents.debugger.commands).toEqual([
        { command: "Page.enable", params: {} },
        {
          command: "Runtime.evaluate",
          params: { expression: expect.any(String), returnByValue: true },
        },
        { command: "Input.dispatchMouseEvent", params: { type: "mousePressed" } },
        { command: "Page.handleJavaScriptDialog", params: { accept: true } },
      ]);

      contents.debugger.blockedCommandNames.clear();
      contents.debugger.finishNextCommand();
      await input;
      return "done";
    });

    await expect(captured).resolves.toEqual({
      result: "done",
      dialogs: [
        {
          type: "alert",
          message: "Saved",
          action: "accepted",
          timestamp: expect.any(Number),
        },
      ],
    });
    expect(contents.debugger.commands.at(-1)).toEqual({
      command: "Runtime.evaluate",
      params: {
        expression: expect.stringContaining("delete window[stateKey]"),
        returnByValue: true,
      },
    });
  });

  test("keeps the prompt shim installed until overlapping captures finish", async () => {
    const contents = new FakeWebContents(26);
    const tab = adaptWebContents(contents);
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const finishFirst = deferred<void>();
    const finishSecond = deferred<void>();

    const first = tab.captureDialogs?.(async () => {
      firstStarted.resolve();
      await finishFirst.promise;
      return "first";
    });
    await firstStarted.promise;

    const second = tab.captureDialogs?.(async () => {
      secondStarted.resolve();
      await finishSecond.promise;
      return "second";
    });
    await secondStarted.promise;

    contents.debugger.promptDialogs.push(
      {
        type: "prompt",
        message: "First?",
        defaultValue: "one",
        action: "dismissed",
        timestamp: 1,
      },
      {
        type: "prompt",
        message: "Second?",
        defaultValue: "two",
        action: "dismissed",
        timestamp: 2,
      },
    );

    finishFirst.resolve();
    await expect(first).resolves.toEqual({
      result: "first",
      dialogs: [
        {
          type: "prompt",
          message: "First?",
          defaultValue: "one",
          action: "dismissed",
          timestamp: 1,
        },
        {
          type: "prompt",
          message: "Second?",
          defaultValue: "two",
          action: "dismissed",
          timestamp: 2,
        },
      ],
    });
    expect(
      contents.debugger.commands.some(
        (entry) =>
          entry.command === "Runtime.evaluate" &&
          typeof entry.params.expression === "string" &&
          entry.params.expression.includes("delete window[stateKey]"),
      ),
    ).toBe(false);

    finishSecond.resolve();
    await expect(second).resolves.toEqual({
      result: "second",
      dialogs: [
        {
          type: "prompt",
          message: "First?",
          defaultValue: "one",
          action: "dismissed",
          timestamp: 1,
        },
        {
          type: "prompt",
          message: "Second?",
          defaultValue: "two",
          action: "dismissed",
          timestamp: 2,
        },
      ],
    });
    expect(contents.debugger.commands.at(-1)).toEqual({
      command: "Runtime.evaluate",
      params: {
        expression: expect.stringContaining("delete window[stateKey]"),
        returnByValue: true,
      },
    });
  });

  test("leaves JavaScript dialogs alone when no capture is active", async () => {
    const contents = new FakeWebContents(28);
    const tab = adaptWebContents(contents);

    await expect(tab.captureDialogs?.(async () => "done")).resolves.toEqual({
      result: "done",
      dialogs: [],
    });
    contents.debugger.emitMessage("Page.javascriptDialogOpening", {
      type: "confirm",
      message: "Unsaved changes?",
    });
    await flushMicrotasks();

    expect(contents.debugger.commands).not.toContainEqual({
      command: "Page.handleJavaScriptDialog",
      params: { accept: false },
    });
  });

  test("treats prompt shim drain failures after navigation as no dialogs", async () => {
    const contents = new FakeWebContents(29);
    contents.debugger.failPromptDrain = true;
    const tab = adaptWebContents(contents);

    await expect(tab.captureDialogs?.(async () => "navigated")).resolves.toEqual({
      result: "navigated",
      dialogs: [],
    });

    expect(contents.debugger.commands).toEqual([
      { command: "Page.enable", params: {} },
      {
        command: "Runtime.evaluate",
        params: { expression: expect.any(String), returnByValue: true },
      },
      {
        command: "Runtime.evaluate",
        params: { expression: expect.any(String), returnByValue: true },
      },
      {
        command: "Runtime.evaluate",
        params: {
          expression: expect.stringContaining("delete window[stateKey]"),
          returnByValue: true,
        },
      },
    ]);
  });

  test("runs the command without dialog capture when CDP setup fails", async () => {
    const contents = new FakeWebContents(30);
    contents.debugger.failedCommandNames.add("Page.enable");
    const tab = adaptWebContents(contents);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(tab.captureDialogs?.(async () => "done")).resolves.toEqual({
      result: "done",
      dialogs: [],
    });

    expect(warn).toHaveBeenCalledWith(
      "[browser-automation] Dialog capture unavailable; running command without it",
      { contentsId: 30, error: expect.any(Error) },
    );
    warn.mockRestore();
  });
});

class FakeHostWebContents {
  private destroyedListener: (() => void) | null = null;

  public constructor(public readonly id: number) {}

  public once(event: "destroyed", listener: () => void): void {
    expect(event).toBe("destroyed");
    this.destroyedListener = listener;
  }

  public destroy(): void {
    this.destroyedListener?.();
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
