import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";
import {
  BROWSER_ELEMENT_BEGIN_CHANNEL,
  BROWSER_ELEMENT_CANCEL_CHANNEL,
  BROWSER_ELEMENT_GUEST_BEGIN_CHANNEL,
  BROWSER_ELEMENT_GUEST_RESULT_CHANNEL,
} from "./channels.js";
import { registerBrowserElementSelectorIpc } from "./index.js";

class FakeIpcMain extends EventEmitter {
  readonly handlers = new Map<string, (...args: never[]) => unknown>();

  handle(channel: string, handler: (...args: never[]) => unknown): void {
    this.handlers.set(channel, handler);
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }
}

class FakeGuest extends EventEmitter {
  readonly id = 77;
  readonly frameSend = vi.fn();
  readonly capturePage = vi.fn(async () => ({
    isEmpty: () => false,
    toDataURL: () => "data:image/png;base64,capture",
  }));
  readonly mainFrame = { framesInSubtree: [{ send: this.frameSend }] };

  isDestroyed(): boolean {
    return false;
  }

  isLoading(): boolean {
    return false;
  }
}

const beginInput = {
  browserId: "browser-1",
  token: "selector-token",
  mode: "annotate" as const,
};
const selection = {
  url: "http://localhost:5173",
  selector: "#save",
  tag: "button",
  text: "Save",
  outerHTML: '<button id="save">Save</button>',
  computedStyles: { display: "flex" },
  boundingRect: { x: 10, y: 20, width: 120, height: 40 },
  reactSource: null,
  parentChain: ["main"],
  children: [],
};

describe("browser element selector IPC", () => {
  test("returns the guest selection with a serialized clipped capture", async () => {
    const ipcMain = new FakeIpcMain();
    const guest = new FakeGuest();
    const dispose = registerBrowserElementSelectorIpc({
      ipcMain: ipcMain as never,
      getGuest: () => guest as never,
    });
    const begin = ipcMain.handlers.get(BROWSER_ELEMENT_BEGIN_CHANNEL);
    expect(begin).toBeTypeOf("function");
    const response = begin!({ sender: { id: 4 } }, beginInput) as Promise<unknown>;
    expect(guest.frameSend).toHaveBeenCalledWith(BROWSER_ELEMENT_GUEST_BEGIN_CHANNEL, beginInput);

    ipcMain.emit(
      BROWSER_ELEMENT_GUEST_RESULT_CHANNEL,
      { sender: guest, senderFrame: guest.mainFrame.framesInSubtree[0] },
      { token: beginInput.token, status: "selected", selection },
    );

    await expect(response).resolves.toEqual({
      status: "selected",
      mode: "annotate",
      selection,
      screenshotDataUrl: "data:image/png;base64,capture",
    });
    expect(guest.capturePage).toHaveBeenCalledWith(selection.boundingRect);
    dispose();
  });

  test("cancels on navigation and ignores a late guest result", async () => {
    const ipcMain = new FakeIpcMain();
    const guest = new FakeGuest();
    registerBrowserElementSelectorIpc({
      ipcMain: ipcMain as never,
      getGuest: () => guest as never,
    });
    const response = ipcMain.handlers.get(BROWSER_ELEMENT_BEGIN_CHANNEL)!(
      { sender: { id: 4 } },
      beginInput,
    ) as Promise<unknown>;
    guest.emit("did-start-navigation", {}, "http://localhost:5173/next", false, true);
    await expect(response).resolves.toEqual({ status: "cancelled" });

    ipcMain.emit(
      BROWSER_ELEMENT_GUEST_RESULT_CHANNEL,
      { sender: guest, senderFrame: guest.mainFrame.framesInSubtree[0] },
      { token: beginInput.token, status: "selected", selection },
    );
    expect(guest.capturePage).not.toHaveBeenCalled();
  });

  test("requires matching host ownership and token when cancelling", async () => {
    const ipcMain = new FakeIpcMain();
    const guest = new FakeGuest();
    registerBrowserElementSelectorIpc({
      ipcMain: ipcMain as never,
      getGuest: (_browserId, hostId) => (hostId === 4 ? (guest as never) : null),
    });
    const begin = ipcMain.handlers.get(BROWSER_ELEMENT_BEGIN_CHANNEL)!;
    const cancel = ipcMain.handlers.get(BROWSER_ELEMENT_CANCEL_CHANNEL)!;
    const response = begin({ sender: { id: 4 } }, beginInput) as Promise<unknown>;
    expect(cancel({ sender: { id: 5 } }, beginInput)).toBe(false);
    expect(cancel({ sender: { id: 4 } }, { ...beginInput, token: "different-token" })).toBe(false);
    expect(cancel({ sender: { id: 4 } }, beginInput)).toBe(true);
    await expect(response).resolves.toEqual({ status: "cancelled" });
  });
});
