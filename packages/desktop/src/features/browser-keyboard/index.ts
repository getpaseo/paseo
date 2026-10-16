import { ipcMain } from "electron";
import { PaseoBrowserWebviewRegistry } from "../browser-webviews/registry.js";
import {
  type BrowserKeyboardPolicy,
  classifyBrowserReservedShortcut,
  matchesBrowserShortcutPrefixes,
  matchesBrowserShortcutPolicy,
  parseBrowserKeyboardPolicy,
  parseBrowserShortcutInput,
} from "./policy.js";

export type { BrowserKeyboardPolicy } from "./policy.js";

const POLICY_INPUT_CHANNEL = "paseo:browser:set-shortcut-policy";
const POLICY_OUTPUT_CHANNEL = "paseo:browser-keyboard-policy";
const POLICY_REQUEST_CHANNEL = "paseo:browser-keyboard-policy-request";
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
  readonly mainFrame: {
    readonly framesInSubtree: ReadonlyArray<{
      readonly detached: boolean;
      send(channel: string, ...args: unknown[]): void;
    }>;
  };
  isDestroyed(): boolean;
  isLoadingMainFrame(): boolean;
  on(event: "dom-ready", listener: () => void): void;
  on(
    event: "before-input-event",
    listener: (event: BrowserKeyboardInputEvent, input: Electron.Input) => void,
  ): void;
  once(event: "destroyed", listener: () => void): void;
  reload(): void;
  reloadIgnoringCache(): void;
  setIgnoreMenuShortcuts(ignore: boolean): void;
  stop(): void;
}

interface BrowserKeyboardHostContents extends BrowserKeyboardContentsIdentity {
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
}

interface BrowserKeyboardGuest {
  contents: BrowserKeyboardGuestContents;
  hostContents: BrowserKeyboardHostContents;
}

export class BrowserKeyboard {
  private readonly attachedGuestsByWebContentsId = new Map<number, BrowserKeyboardGuest>();
  private readonly policiesByHostWebContentsId = new Map<number, BrowserKeyboardPolicy>();

  public constructor(private readonly browserRegistry: PaseoBrowserWebviewRegistry) {}

  public registerIpc(): void {
    ipcMain.handle(POLICY_INPUT_CHANNEL, (event, rawPolicy: unknown) => {
      this.publish(event.sender.id, rawPolicy);
    });
    ipcMain.on(SHORTCUT_INPUT_CHANNEL, (event, rawInput: unknown) => {
      this.forwardShortcutInput(event.sender, rawInput);
    });
    ipcMain.on(POLICY_REQUEST_CHANNEL, (event) => {
      const payload = this.policyForGuest(event.sender);
      if (payload) {
        event.reply(POLICY_OUTPUT_CHANNEL, payload);
      }
    });
  }

  public attach(input: {
    contents: BrowserKeyboardGuestContents;
    hostContents: BrowserKeyboardHostContents;
  }): void {
    const webContentsId = input.contents.id;
    const registration = this.browserRegistry.getRegistrationForWebContents(webContentsId);
    if (!registration || registration.hostWebContentsId !== input.hostContents.id) {
      return;
    }
    const attachedGuest = this.attachedGuestsByWebContentsId.get(webContentsId);
    if (
      attachedGuest?.contents === input.contents &&
      attachedGuest.hostContents === input.hostContents
    ) {
      return;
    }
    const guest: BrowserKeyboardGuest = input;
    this.attachedGuestsByWebContentsId.set(webContentsId, guest);

    input.contents.once("destroyed", () => {
      if (this.attachedGuestsByWebContentsId.get(webContentsId) === guest) {
        this.attachedGuestsByWebContentsId.delete(webContentsId);
      }
    });
    input.contents.on("dom-ready", () => {
      const currentRegistration = this.registrationForGuest(webContentsId, guest);
      if (!currentRegistration) {
        return;
      }
      const policy = this.policiesByHostWebContentsId.get(currentRegistration.hostWebContentsId);
      if (policy) {
        this.sendPolicy(guest, currentRegistration.browserId, policy);
      }
    });
    input.contents.on("before-input-event", (event, keyboardInput) => {
      const currentRegistration = this.registrationForGuest(webContentsId, guest);
      if (currentRegistration) {
        this.handleGuestInput(guest, currentRegistration, event, keyboardInput);
      }
    });

    const policy = this.policiesByHostWebContentsId.get(registration.hostWebContentsId);
    if (policy) {
      this.sendPolicy(guest, registration.browserId, policy);
    }
  }

  public publish(hostWebContentsId: number, rawPolicy: unknown): void {
    const policy = parseBrowserKeyboardPolicy(rawPolicy);
    if (!policy) {
      return;
    }
    this.policiesByHostWebContentsId.set(hostWebContentsId, policy);
    for (const [webContentsId, guest] of this.attachedGuestsByWebContentsId) {
      const registration = this.registrationForGuest(webContentsId, guest);
      if (registration?.hostWebContentsId === hostWebContentsId) {
        this.sendPolicy(guest, registration.browserId, policy);
      }
    }
  }

  public forwardShortcutInput(contents: BrowserKeyboardContentsIdentity, rawInput: unknown): void {
    const input = parseBrowserShortcutInput(rawInput);
    if (!input) {
      return;
    }
    const guest = this.attachedGuestsByWebContentsId.get(contents.id);
    if (!guest) {
      return;
    }
    const registration = this.registrationForGuest(contents.id, guest);
    if (
      !registration ||
      registration.browserId !== input.browserId ||
      guest.hostContents.isDestroyed()
    ) {
      return;
    }
    guest.hostContents.send(SHORTCUT_OUTPUT_CHANNEL, input);
  }

  public detachHost(hostWebContentsId: number): void {
    this.policiesByHostWebContentsId.delete(hostWebContentsId);
  }

  private handleGuestInput(
    guest: BrowserKeyboardGuest,
    registration: { browserId: string; hostWebContentsId: number },
    event: BrowserKeyboardInputEvent,
    input: Electron.Input,
  ): void {
    const policy = this.policiesByHostWebContentsId.get(registration.hostWebContentsId);
    const matchInput = {
      alt: input.alt,
      code: input.code,
      control: input.control,
      key: input.key,
      meta: input.meta,
      repeat: input.isAutoRepeat,
      shift: input.shift,
    };
    const belongsToBrowserPolicy =
      policy !== undefined && matchesBrowserShortcutPolicy(policy, matchInput);
    const belongsToMenuPolicy =
      policy !== undefined && matchesBrowserShortcutPrefixes(policy.menuPrefixes, matchInput);
    guest.contents.setIgnoreMenuShortcuts(
      (!input.control && !input.meta) || belongsToBrowserPolicy || belongsToMenuPolicy,
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
        event.preventDefault();
        if (!guest.hostContents.isDestroyed()) {
          guest.hostContents.send(RESERVED_SHORTCUT_OUTPUT_CHANNEL, {
            action: reservedShortcut,
            browserId: registration.browserId,
          });
        }
        return;
      case null:
        return;
    }
  }

  private registrationForGuest(
    webContentsId: number,
    guest: BrowserKeyboardGuest,
  ): { browserId: string; hostWebContentsId: number } | null {
    if (this.attachedGuestsByWebContentsId.get(webContentsId) !== guest) {
      return null;
    }
    if (guest.hostContents.isDestroyed()) {
      return null;
    }
    const registration = this.browserRegistry.getRegistrationForWebContents(webContentsId);
    return registration?.hostWebContentsId === guest.hostContents.id ? registration : null;
  }

  private sendPolicy(
    guest: BrowserKeyboardGuest,
    browserId: string,
    policy: BrowserKeyboardPolicy,
  ): void {
    if (guest.contents.isDestroyed()) {
      return;
    }
    const payload = { ...policy, browserId };
    for (const frame of guest.contents.mainFrame.framesInSubtree) {
      if (!frame.detached) {
        frame.send(POLICY_OUTPUT_CHANNEL, payload);
      }
    }
  }

  private policyForGuest(
    contents: BrowserKeyboardContentsIdentity,
  ): (BrowserKeyboardPolicy & { browserId: string }) | null {
    const guest = this.attachedGuestsByWebContentsId.get(contents.id);
    if (!guest) {
      return null;
    }
    const registration = this.registrationForGuest(contents.id, guest);
    if (!registration) {
      return null;
    }
    const policy = this.policiesByHostWebContentsId.get(registration.hostWebContentsId);
    return policy ? { ...policy, browserId: registration.browserId } : null;
  }
}
