import { describe, expect, test } from "vitest";
import { PaseoBrowserWebviewRegistry } from "../browser-webviews/registry.js";
import { BrowserKeyboard } from "./index.js";

interface SentMessage {
  channel: string;
  payload: unknown;
}

class FakeBrowserContents {
  public readonly mainFrame = {
    framesInSubtree: [
      {
        detached: false,
        send: (channel: string, payload: unknown) => this.send(channel, payload),
      },
    ],
  };
  public readonly ignoredMenuShortcuts: boolean[] = [];
  public readonly reloads: string[] = [];
  public readonly sent: SentMessage[] = [];
  private destroyed = false;
  private readonly destroyedListeners: Array<() => void> = [];
  private readonly domReadyListeners: Array<() => void> = [];
  private finishLoadListener: (() => void) | null = null;
  private readonly inputListeners: Array<
    (event: { preventDefault(): void }, input: Electron.Input) => void
  > = [];

  public constructor(private readonly webContentsId: number) {}

  public get id(): number {
    if (this.destroyed) {
      throw new TypeError("Object has been destroyed");
    }
    return this.webContentsId;
  }

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public isLoadingMainFrame(): boolean {
    return false;
  }

  public once(event: "destroyed", listener: () => void): void {
    expect(event).toBe("destroyed");
    this.destroyedListeners.push(listener);
  }

  public on(event: "did-finish-load", listener: () => void): void;
  public on(event: "dom-ready", listener: () => void): void;
  public on(
    event: "before-input-event",
    listener: (event: { preventDefault(): void }, input: Electron.Input) => void,
  ): void;
  public on(
    event: "did-finish-load" | "dom-ready" | "before-input-event",
    listener: (() => void) | ((event: { preventDefault(): void }, input: Electron.Input) => void),
  ): void {
    if (event === "did-finish-load") {
      this.finishLoadListener = listener as () => void;
      return;
    }
    if (event === "dom-ready") {
      this.domReadyListeners.push(listener as () => void);
      return;
    }
    this.inputListeners.push(
      listener as (event: { preventDefault(): void }, input: Electron.Input) => void,
    );
  }

  public send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload });
  }

  public setIgnoreMenuShortcuts(ignore: boolean): void {
    this.ignoredMenuShortcuts.push(ignore);
  }

  public stop(): void {
    this.reloads.push("stop");
  }

  public reload(): void {
    this.reloads.push("reload");
  }

  public reloadIgnoringCache(): void {
    this.reloads.push("force-reload");
  }

  public destroy(): void {
    this.destroyed = true;
    for (const listener of this.destroyedListeners) {
      listener();
    }
  }

  public finishLoad(): void {
    this.finishLoadListener?.();
  }

  public domReady(): void {
    for (const listener of this.domReadyListeners) {
      listener();
    }
  }

  public input(input: Electron.Input): boolean {
    let wasPrevented = false;
    for (const listener of this.inputListeners) {
      listener(
        {
          preventDefault: () => {
            wasPrevented = true;
          },
        },
        input,
      );
    }
    return wasPrevented;
  }
}

function electronInput(input: Partial<Electron.Input>): Electron.Input {
  return {
    alt: false,
    code: "",
    control: false,
    isAutoRepeat: false,
    isComposing: false,
    key: "",
    location: 0,
    meta: false,
    modifiers: [],
    shift: false,
    type: "keyDown",
    ...input,
  };
}

function createBrowserKeyboard() {
  const registry = new PaseoBrowserWebviewRegistry();
  const keyboard = new BrowserKeyboard(registry);

  function attach(input: {
    browserId: string;
    contents: FakeBrowserContents;
    hostContents: FakeBrowserContents;
  }): void {
    const webContentsId = input.contents.id;
    registry.registerWebContents({
      browserId: input.browserId,
      hostWebContentsId: input.hostContents.id,
      webContentsId,
    });
    input.contents.once("destroyed", () => registry.unregisterWebContents(webContentsId));
    keyboard.attach(input);
  }

  return { attach, keyboard };
}

describe("BrowserKeyboard", () => {
  test("forwards a validated guest shortcut to its host", () => {
    const { attach, keyboard } = createBrowserKeyboard();
    const guest = new FakeBrowserContents(51);
    const host = new FakeBrowserContents(52);
    attach({ browserId: "browser-a", contents: guest, hostContents: host });

    keyboard.forwardShortcutInput(guest, {
      alt: false,
      browserId: "browser-a",
      code: "KeyB",
      control: true,
      key: "b",
      meta: false,
      repeat: false,
      shift: false,
    });

    expect(host.sent).toEqual([
      {
        channel: "paseo:event:browser-shortcut-input",
        payload: {
          alt: false,
          browserId: "browser-a",
          code: "KeyB",
          control: true,
          key: "b",
          meta: false,
          repeat: false,
          shift: false,
        },
      },
    ]);
  });

  test("handles a reserved shortcut once when the same guest attaches again", () => {
    const { attach } = createBrowserKeyboard();
    const guest = new FakeBrowserContents(53);
    const host = new FakeBrowserContents(54);
    attach({ browserId: "browser-a", contents: guest, hostContents: host });
    attach({ browserId: "browser-a", contents: guest, hostContents: host });
    const command = process.platform === "darwin" ? { meta: true } : { control: true };

    const wasPrevented = guest.input(electronInput({ ...command, code: "KeyR", key: "r" }));

    expect(wasPrevented).toBe(true);
    expect(guest.reloads).toEqual(["reload"]);
  });

  test("republishes the latest shortcut policy when the next guest document is ready", () => {
    const { attach, keyboard } = createBrowserKeyboard();
    const guest = new FakeBrowserContents(61);
    const host = new FakeBrowserContents(62);
    const initialPolicy = {
      menuPrefixes: [
        {
          alt: false,
          code: "KeyB",
          control: true,
          meta: false,
          repeat: false as const,
          shift: false,
        },
      ],
      prefixes: [
        {
          alt: false,
          code: "KeyB",
          control: true,
          meta: false,
          repeat: false as const,
          shift: false,
        },
      ],
    };
    const latestPolicy = { menuPrefixes: [], prefixes: [] };
    keyboard.publish(host.id, initialPolicy);
    attach({ browserId: "browser-a", contents: guest, hostContents: host });
    keyboard.publish(host.id, latestPolicy);

    guest.domReady();

    expect(guest.sent).toEqual([
      {
        channel: "paseo:browser-keyboard-policy",
        payload: { ...initialPolicy, browserId: "browser-a" },
      },
      {
        channel: "paseo:browser-keyboard-policy",
        payload: { ...latestPolicy, browserId: "browser-a" },
      },
      {
        channel: "paseo:browser-keyboard-policy",
        payload: { ...latestPolicy, browserId: "browser-a" },
      },
    ]);

    guest.finishLoad();
    expect(guest.sent).toHaveLength(3);
  });

  test("ignores guest lifecycle events after the host is destroyed", () => {
    const { attach, keyboard } = createBrowserKeyboard();
    const guest = new FakeBrowserContents(71);
    const host = new FakeBrowserContents(72);
    attach({ browserId: "browser-a", contents: guest, hostContents: host });
    keyboard.publish(host.id, { menuPrefixes: [], prefixes: [] });

    host.destroy();
    guest.domReady();

    expect(guest.sent).toEqual([
      {
        channel: "paseo:browser-keyboard-policy",
        payload: { browserId: "browser-a", menuPrefixes: [], prefixes: [] },
      },
    ]);
  });

  test("owns browser chrome shortcuts and leaves customizable shortcuts to policy", () => {
    const { attach } = createBrowserKeyboard();
    const guest = new FakeBrowserContents(81);
    const host = new FakeBrowserContents(82);
    attach({ browserId: "browser-a", contents: guest, hostContents: host });
    const command = process.platform === "darwin" ? { meta: true } : { control: true };

    const reservedWasPrevented = guest.input(electronInput({ ...command, code: "KeyL", key: "l" }));
    const customizableWasPrevented = guest.input(
      electronInput({ ...command, code: "KeyT", key: "t" }),
    );
    const enterWasPrevented = guest.input(electronInput({ code: "Enter", key: "Enter" }));

    expect(reservedWasPrevented).toBe(true);
    expect(customizableWasPrevented).toBe(false);
    expect(enterWasPrevented).toBe(false);
    expect(guest.ignoredMenuShortcuts).toEqual([false, false, true]);
    expect(host.sent).toEqual([
      {
        channel: "paseo:event:browser-shortcut",
        payload: { action: "focus-url", browserId: "browser-a" },
      },
    ]);
  });

  test("keeps policy-owned shortcuts out of the application menu without preempting the page", () => {
    const { attach, keyboard } = createBrowserKeyboard();
    const guest = new FakeBrowserContents(91);
    const host = new FakeBrowserContents(92);
    keyboard.publish(host.id, {
      menuPrefixes: [
        { alt: false, code: "KeyW", control: true, meta: false, repeat: false, shift: false },
      ],
      prefixes: [
        { alt: false, code: "KeyW", control: true, meta: false, repeat: false, shift: false },
      ],
    });
    attach({ browserId: "browser-a", contents: guest, hostContents: host });

    const wasPrevented = guest.input(electronInput({ code: "KeyW", control: true, key: "w" }));

    expect(wasPrevented).toBe(false);
    expect(guest.ignoredMenuShortcuts).toEqual([true]);
  });

  test("keeps idle policy shortcuts out of the application menu while a chord is pending", () => {
    const { attach, keyboard } = createBrowserKeyboard();
    const guest = new FakeBrowserContents(101);
    const host = new FakeBrowserContents(102);
    keyboard.publish(host.id, {
      menuPrefixes: [
        { alt: false, code: "KeyW", control: true, meta: false, repeat: false, shift: false },
      ],
      prefixes: [
        { alt: false, code: "F11", control: true, meta: false, repeat: false, shift: false },
      ],
    });
    attach({ browserId: "browser-a", contents: guest, hostContents: host });

    const wasPrevented = guest.input(electronInput({ code: "KeyW", control: true, key: "w" }));

    expect(wasPrevented).toBe(false);
    expect(guest.ignoredMenuShortcuts).toEqual([true]);
  });
});
