import { ipcMain } from "electron";
import {
  type BrowserKeyboardPolicy,
  classifyBrowserReservedShortcut,
  matchesBrowserShortcutPolicy,
  parseBrowserKeyboardPolicy,
  parseBrowserShortcutInput,
} from "./policy.js";

export type { BrowserKeyboardPolicy } from "./policy.js";

const POLICY_INPUT_CHANNEL = "paseo:browser:set-shortcut-policy";
const POLICY_OUTPUT_CHANNEL = "paseo:browser-keyboard-policy";
const SHORTCUT_INPUT_CHANNEL = "paseo:browser-shortcut-input";
const SHORTCUT_OUTPUT_CHANNEL = "paseo:event:browser-shortcut-input";
const RESERVED_SHORTCUT_OUTPUT_CHANNEL = "paseo:event:browser-shortcut";

interface BrowserKeyboardContentsIdentity {
  readonly id: number;
}

interface BrowserKeyboardInputEvent {
  preventDefault(): void;
}

interface BrowserKeyboardGuestContents extends BrowserKeyboardContentsIdentity {
  isDestroyed(): boolean;
  isLoadingMainFrame(): boolean;
  on(event: "did-finish-load", listener: () => void): void;
  on(
    event: "before-input-event",
    listener: (event: BrowserKeyboardInputEvent, input: Electron.Input) => void,
  ): void;
  once(event: "destroyed", listener: () => void): void;
  reload(): void;
  reloadIgnoringCache(): void;
  send(channel: string, ...args: unknown[]): void;
  setIgnoreMenuShortcuts(ignore: boolean): void;
  stop(): void;
}

interface BrowserKeyboardHostContents extends BrowserKeyboardContentsIdentity {
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
}

interface BrowserKeyboardGuest {
  browserId: string;
  contents: BrowserKeyboardGuestContents;
  hostContents: BrowserKeyboardHostContents;
  hostWebContentsId: number;
  webContentsId: number;
}

export class BrowserKeyboard {
  private readonly guestsByBrowserId = new Map<string, BrowserKeyboardGuest>();
  private readonly guestsByWebContentsId = new Map<number, BrowserKeyboardGuest>();
  private readonly policiesByHostWebContentsId = new Map<number, BrowserKeyboardPolicy>();

  public registerIpc(): void {
    ipcMain.handle(POLICY_INPUT_CHANNEL, (event, rawPolicy: unknown) => {
      this.publish(event.sender.id, rawPolicy);
    });
    ipcMain.on(SHORTCUT_INPUT_CHANNEL, (event, rawInput: unknown) => {
      this.forwardShortcutInput(event.sender, rawInput);
    });
  }

  public attach(input: {
    browserId: string;
    contents: BrowserKeyboardGuestContents;
    hostContents: BrowserKeyboardHostContents;
  }): void {
    const guest: BrowserKeyboardGuest = {
      ...input,
      hostWebContentsId: input.hostContents.id,
      webContentsId: input.contents.id,
    };
    const guestAtWebContentsId = this.guestsByWebContentsId.get(guest.webContentsId);
    if (guestAtWebContentsId) {
      this.detachGuest(guestAtWebContentsId);
    }
    const guestForBrowser = this.guestsByBrowserId.get(guest.browserId);
    if (guestForBrowser) {
      this.detachGuest(guestForBrowser);
    }
    this.guestsByBrowserId.set(guest.browserId, guest);
    this.guestsByWebContentsId.set(guest.webContentsId, guest);

    input.contents.once("destroyed", () => {
      this.detachGuest(guest);
    });
    input.contents.on("did-finish-load", () => {
      if (this.guestsByWebContentsId.get(guest.webContentsId) !== guest) {
        return;
      }
      const policy = this.policiesByHostWebContentsId.get(guest.hostWebContentsId);
      if (policy) {
        this.sendPolicy(guest, policy);
      }
    });
    input.contents.on("before-input-event", (event, keyboardInput) => {
      if (this.guestsByWebContentsId.get(guest.webContentsId) === guest) {
        this.handleGuestInput(guest, event, keyboardInput);
      }
    });

    const policy = this.policiesByHostWebContentsId.get(guest.hostWebContentsId);
    if (policy) {
      this.sendPolicy(guest, policy);
    }
  }

  public publish(hostWebContentsId: number, rawPolicy: unknown): void {
    const policy = parseBrowserKeyboardPolicy(rawPolicy);
    if (!policy) {
      return;
    }
    this.policiesByHostWebContentsId.set(hostWebContentsId, policy);
    for (const guest of this.guestsByWebContentsId.values()) {
      if (guest.hostWebContentsId === hostWebContentsId) {
        this.sendPolicy(guest, policy);
      }
    }
  }

  public forwardShortcutInput(contents: BrowserKeyboardContentsIdentity, rawInput: unknown): void {
    const input = parseBrowserShortcutInput(rawInput);
    if (!input) {
      return;
    }
    const guest = this.guestsByWebContentsId.get(contents.id);
    if (!guest || guest.browserId !== input.browserId || guest.hostContents.isDestroyed()) {
      return;
    }
    guest.hostContents.send(SHORTCUT_OUTPUT_CHANNEL, input);
  }

  public detachHost(hostWebContentsId: number): void {
    this.policiesByHostWebContentsId.delete(hostWebContentsId);
    for (const guest of this.guestsByWebContentsId.values()) {
      if (guest.hostWebContentsId === hostWebContentsId) {
        this.detachGuest(guest);
      }
    }
  }

  private detachGuest(guest: BrowserKeyboardGuest): void {
    if (this.guestsByWebContentsId.get(guest.webContentsId) === guest) {
      this.guestsByWebContentsId.delete(guest.webContentsId);
    }
    if (this.guestsByBrowserId.get(guest.browserId) === guest) {
      this.guestsByBrowserId.delete(guest.browserId);
    }
  }

  private handleGuestInput(
    guest: BrowserKeyboardGuest,
    event: BrowserKeyboardInputEvent,
    input: Electron.Input,
  ): void {
    const policy = this.policiesByHostWebContentsId.get(guest.hostWebContentsId);
    const belongsToBrowserPolicy =
      policy !== undefined &&
      matchesBrowserShortcutPolicy(policy, {
        alt: input.alt,
        code: input.code,
        control: input.control,
        key: input.key,
        meta: input.meta,
        repeat: input.isAutoRepeat,
        shift: input.shift,
      });
    guest.contents.setIgnoreMenuShortcuts(
      (!input.control && !input.meta) || belongsToBrowserPolicy,
    );
    const reservedShortcut = classifyBrowserReservedShortcut(input, {
      isMac: process.platform === "darwin",
    });

    switch (reservedShortcut) {
      case "force-reload":
        event.preventDefault();
        guest.contents.reloadIgnoringCache();
        return;
      case "reload":
        event.preventDefault();
        if (guest.contents.isLoadingMainFrame()) {
          guest.contents.stop();
        } else {
          guest.contents.reload();
        }
        return;
      case "focus-url":
      case "new-tab":
        event.preventDefault();
        if (!guest.hostContents.isDestroyed()) {
          guest.hostContents.send(RESERVED_SHORTCUT_OUTPUT_CHANNEL, {
            action: reservedShortcut,
            browserId: guest.browserId,
          });
        }
        return;
      case null:
        return;
    }
  }

  private sendPolicy(guest: BrowserKeyboardGuest, policy: BrowserKeyboardPolicy): void {
    if (!guest.contents.isDestroyed()) {
      guest.contents.send(POLICY_OUTPUT_CHANNEL, { ...policy, browserId: guest.browserId });
    }
  }
}
