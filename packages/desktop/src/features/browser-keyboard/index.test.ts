import { describe, expect, test } from "vitest";
import { BrowserKeyboard } from "./index.js";

interface SentMessage {
  channel: string;
  payload: unknown;
}

class FakeBrowserContents {
  public readonly ignoredMenuShortcuts: boolean[] = [];
  public readonly reloads: string[] = [];
  public readonly sent: SentMessage[] = [];
  private destroyed = false;
  private destroyedListener: (() => void) | null = null;
  private finishLoadListener: (() => void) | null = null;
  private inputListener:
    | ((event: { preventDefault(): void }, input: Electron.Input) => void)
    | null = null;

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
    this.destroyedListener = listener;
  }

  public on(event: "did-finish-load", listener: () => void): void;
  public on(
    event: "before-input-event",
    listener: (event: { preventDefault(): void }, input: Electron.Input) => void,
  ): void;
  public on(
    event: "did-finish-load" | "before-input-event",
    listener: (() => void) | ((event: { preventDefault(): void }, input: Electron.Input) => void),
  ): void {
    if (event === "did-finish-load") {
      this.finishLoadListener = listener as () => void;
      return;
    }
    this.inputListener = listener as (
      event: { preventDefault(): void },
      input: Electron.Input,
    ) => void;
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
    this.destroyedListener?.();
  }

  public finishLoad(): void {
    this.finishLoadListener?.();
  }

  public input(input: Electron.Input): boolean {
    let wasPrevented = false;
    this.inputListener?.(
      {
        preventDefault: () => {
          wasPrevented = true;
        },
      },
      input,
    );
    return wasPrevented;
  }
}

function shortcutInput(browserId: string) {
  return {
    alt: false,
    browserId,
    code: "KeyB",
    control: true,
    key: "b",
    meta: false,
    repeat: false,
    shift: false,
  };
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

describe("BrowserKeyboard", () => {
  test("forgets a guest after Electron invalidates its wrapper", () => {
    const keyboard = new BrowserKeyboard();
    const guest = new FakeBrowserContents(41);
    const host = new FakeBrowserContents(42);
    const liveContentsWithSameId = new FakeBrowserContents(41);
    keyboard.attach({ browserId: "browser-a", contents: guest, hostContents: host });

    expect(() => guest.destroy()).not.toThrow();
    keyboard.forwardShortcutInput(liveContentsWithSameId, shortcutInput("browser-a"));

    expect(host.sent).toEqual([]);
  });

  test("does not let a stale destroy event detach a replacement guest", () => {
    const keyboard = new BrowserKeyboard();
    const staleGuest = new FakeBrowserContents(51);
    const replacementGuest = new FakeBrowserContents(51);
    const staleHost = new FakeBrowserContents(52);
    const replacementHost = new FakeBrowserContents(53);
    keyboard.attach({
      browserId: "browser-a",
      contents: staleGuest,
      hostContents: staleHost,
    });
    keyboard.attach({
      browserId: "browser-a",
      contents: replacementGuest,
      hostContents: replacementHost,
    });

    staleGuest.destroy();
    keyboard.forwardShortcutInput(replacementGuest, shortcutInput("browser-a"));

    expect(staleHost.sent).toEqual([]);
    expect(replacementHost.sent).toEqual([
      {
        channel: "paseo:event:browser-shortcut-input",
        payload: shortcutInput("browser-a"),
      },
    ]);
  });

  test("accepts input only from the authoritative guest for a browser", () => {
    const keyboard = new BrowserKeyboard();
    const staleGuest = new FakeBrowserContents(54);
    const currentGuest = new FakeBrowserContents(55);
    const host = new FakeBrowserContents(56);
    keyboard.attach({ browserId: "browser-a", contents: staleGuest, hostContents: host });
    keyboard.attach({ browserId: "browser-a", contents: currentGuest, hostContents: host });

    keyboard.forwardShortcutInput(staleGuest, shortcutInput("browser-a"));
    keyboard.forwardShortcutInput(currentGuest, shortcutInput("browser-a"));

    expect(host.sent).toEqual([
      {
        channel: "paseo:event:browser-shortcut-input",
        payload: shortcutInput("browser-a"),
      },
    ]);
  });

  test("resends the latest shortcut policy after every main-frame load", () => {
    const keyboard = new BrowserKeyboard();
    const guest = new FakeBrowserContents(61);
    const host = new FakeBrowserContents(62);
    const initialPolicy = {
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
    const latestPolicy = { prefixes: [] };
    keyboard.publish(host.id, initialPolicy);
    keyboard.attach({ browserId: "browser-a", contents: guest, hostContents: host });
    keyboard.publish(host.id, latestPolicy);

    guest.finishLoad();
    guest.finishLoad();

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
      {
        channel: "paseo:browser-keyboard-policy",
        payload: { ...latestPolicy, browserId: "browser-a" },
      },
    ]);
  });

  test("forgets policy and guests when their host window closes", () => {
    const keyboard = new BrowserKeyboard();
    const guest = new FakeBrowserContents(71);
    const host = new FakeBrowserContents(72);
    const policy = { prefixes: [] };
    keyboard.publish(host.id, policy);
    keyboard.attach({ browserId: "browser-a", contents: guest, hostContents: host });

    keyboard.detachHost(host.id);
    guest.finishLoad();
    keyboard.forwardShortcutInput(guest, shortcutInput("browser-a"));

    expect(guest.sent).toEqual([
      {
        channel: "paseo:browser-keyboard-policy",
        payload: { ...policy, browserId: "browser-a" },
      },
    ]);
    expect(host.sent).toEqual([]);
  });

  test("owns reserved shortcuts and leaves plain guest input contained", () => {
    const keyboard = new BrowserKeyboard();
    const guest = new FakeBrowserContents(81);
    const host = new FakeBrowserContents(82);
    keyboard.attach({ browserId: "browser-a", contents: guest, hostContents: host });
    const command = process.platform === "darwin" ? { meta: true } : { control: true };

    const reservedWasPrevented = guest.input(electronInput({ ...command, code: "KeyT", key: "t" }));
    const enterWasPrevented = guest.input(electronInput({ code: "Enter", key: "Enter" }));

    expect(reservedWasPrevented).toBe(true);
    expect(enterWasPrevented).toBe(false);
    expect(guest.ignoredMenuShortcuts).toEqual([false, true]);
    expect(host.sent).toEqual([
      {
        channel: "paseo:event:browser-shortcut",
        payload: { action: "new-tab", browserId: "browser-a" },
      },
    ]);
  });

  test("keeps policy-owned shortcuts out of the application menu without preempting the page", () => {
    const keyboard = new BrowserKeyboard();
    const guest = new FakeBrowserContents(91);
    const host = new FakeBrowserContents(92);
    keyboard.publish(host.id, {
      prefixes: [
        { alt: false, code: "KeyW", control: true, meta: false, repeat: false, shift: false },
      ],
    });
    keyboard.attach({ browserId: "browser-a", contents: guest, hostContents: host });

    const wasPrevented = guest.input(electronInput({ code: "KeyW", control: true, key: "w" }));

    expect(wasPrevented).toBe(false);
    expect(guest.ignoredMenuShortcuts).toEqual([true]);
  });
});
