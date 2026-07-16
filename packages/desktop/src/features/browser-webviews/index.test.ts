import { describe, expect, test, vi } from "vitest";
import { PASEO_BROWSER_PROFILE_PARTITION } from "../browser-profile.js";

vi.mock("electron", () => ({
  webContents: {
    fromId: vi.fn(),
  },
}));

import {
  getPaseoBrowserIdForWebContents,
  getPaseoBrowserWorkspaceId,
  isPaseoBrowserWebviewAttach,
  registerAttachedPaseoBrowser,
  unregisterPaseoBrowser,
  getPaseoBrowserOwnerWebContentsId,
  BROWSER_FOUND_IN_PAGE_EVENT,
} from "./index.js";

class FakeOwnerWebContents {
  private destroyed = false;
  private destroyedListener: (() => void) | null = null;
  private navigateListener:
    | ((event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void)
    | null = null;
  public readonly sentEvents: Array<{ channel: string; args: unknown[] }> = [];

  public constructor(public readonly id: number) {}

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public send(channel: string, ...args: unknown[]): void {
    this.sentEvents.push({ channel, args });
  }

  public once(event: "destroyed", listener: () => void): void {
    expect(event).toBe("destroyed");
    this.destroyedListener = listener;
  }

  public on(event: "did-start-navigation", listener: unknown): void {
    expect(event).toBe("did-start-navigation");
    this.navigateListener = listener as (
      event: unknown,
      url: string,
      isInPlace: boolean,
      isMainFrame: boolean,
    ) => void;
  }

  public removeListener(_event: string, _listener: unknown): void {
    // simple mock
  }

  public destroy(): void {
    this.destroyed = true;
    this.destroyedListener?.();
  }

  public navigate(url: string, isMainFrame: boolean): void {
    this.navigateListener?.({}, url, false, isMainFrame);
  }
}

class FakeBrowserGuest {
  public readonly backgroundThrottlingCalls: boolean[] = [];
  private destroyedListener: (() => void) | null = null;
  private destroyed = false;
  private readonly foundInPageListeners = new Set<(event: unknown, result: unknown) => void>();
  public removedListeners: string[] = [];

  public get foundInPageListenerCount(): number {
    return this.foundInPageListeners.size;
  }

  public constructor(
    public readonly id: number,
    public readonly hostWebContents: FakeOwnerWebContents,
    public readonly session: object,
  ) {}

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public setBackgroundThrottling(allowed: boolean): void {
    this.backgroundThrottlingCalls.push(allowed);
  }

  public once(event: "destroyed", listener: () => void): void {
    expect(event).toBe("destroyed");
    this.destroyedListener = listener;
  }

  public on(event: string, listener: unknown): void {
    if (event === "found-in-page") {
      this.foundInPageListeners.add(listener as (event: unknown, result: unknown) => void);
    }
  }

  public removeListener(event: string, listener: unknown): void {
    this.removedListeners.push(event);
    if (event === "found-in-page") {
      this.foundInPageListeners.delete(listener as (event: unknown, result: unknown) => void);
    }
  }

  public destroy(): void {
    this.destroyed = true;
    this.destroyedListener?.();
  }

  public triggerFoundInPage(result: unknown): void {
    for (const listener of this.foundInPageListeners) {
      listener({}, result);
    }
  }
}

describe("browser webview attachment", () => {
  test("accepts only allowed URLs on the shared profile partition", () => {
    expect(
      isPaseoBrowserWebviewAttach({
        src: "https://example.com",
        partition: PASEO_BROWSER_PROFILE_PARTITION,
      }),
    ).toBe(true);
    expect(
      isPaseoBrowserWebviewAttach({
        src: "https://example.com",
        partition: "persist:paseo-browser-tab-a",
      }),
    ).toBe(false);
    expect(
      isPaseoBrowserWebviewAttach({ src: "https://example.com", partition: "persist:foreign" }),
    ).toBe(false);
  });

  test("binds explicit browser identity to the renderer that hosts the guest", () => {
    const profileSession = {};
    const renderer = new FakeOwnerWebContents(1);
    const guest = new FakeBrowserGuest(101, renderer, profileSession);

    const registered = registerAttachedPaseoBrowser({
      browserId: "browser-a",
      workspaceId: "workspace-a",
      webContentsId: guest.id,
      sender: renderer,
      profileSession,
      findWebContents: () => guest,
    });

    expect(registered).toBe(true);
    expect(getPaseoBrowserIdForWebContents(guest)).toBe("browser-a");
    expect(getPaseoBrowserWorkspaceId("browser-a")).toBe("workspace-a");
  });

  test("rejects a guest hosted by another renderer", () => {
    const profileSession = {};
    const owner = new FakeOwnerWebContents(1);
    const claimant = new FakeOwnerWebContents(2);
    const guest = new FakeBrowserGuest(201, owner, profileSession);

    const registered = registerAttachedPaseoBrowser({
      browserId: "browser-a",
      workspaceId: "workspace-a",
      webContentsId: guest.id,
      sender: claimant,
      profileSession,
      findWebContents: () => guest,
    });

    expect(registered).toBe(false);
    expect(getPaseoBrowserIdForWebContents(guest)).toBeNull();
  });

  test("rejects a guest outside the shared profile", () => {
    const profileSession = {};
    const renderer = new FakeOwnerWebContents(1);
    const guest = new FakeBrowserGuest(301, renderer, {});

    const registered = registerAttachedPaseoBrowser({
      browserId: "browser-a",
      workspaceId: "workspace-a",
      webContentsId: guest.id,
      sender: renderer,
      profileSession,
      findWebContents: () => guest,
    });

    expect(registered).toBe(false);
    expect(getPaseoBrowserIdForWebContents(guest)).toBeNull();
  });

  test("concurrent windows cannot swap browser identities", () => {
    const profileSession = {};
    const firstRenderer = new FakeOwnerWebContents(1);
    const secondRenderer = new FakeOwnerWebContents(2);
    const firstGuest = new FakeBrowserGuest(401, firstRenderer, profileSession);
    const secondGuest = new FakeBrowserGuest(402, secondRenderer, profileSession);
    const guests = new Map([
      [firstGuest.id, firstGuest],
      [secondGuest.id, secondGuest],
    ]);

    registerAttachedPaseoBrowser({
      browserId: "browser-second",
      workspaceId: "workspace-second",
      webContentsId: secondGuest.id,
      sender: secondRenderer,
      profileSession,
      findWebContents: (id) => guests.get(id) ?? null,
    });
    registerAttachedPaseoBrowser({
      browserId: "browser-first",
      workspaceId: "workspace-first",
      webContentsId: firstGuest.id,
      sender: firstRenderer,
      profileSession,
      findWebContents: (id) => guests.get(id) ?? null,
    });

    expect(getPaseoBrowserIdForWebContents(firstGuest)).toBe("browser-first");
    expect(getPaseoBrowserIdForWebContents(secondGuest)).toBe("browser-second");
  });

  test("prepares throttling once and removes registration when the guest is destroyed", () => {
    const profileSession = {};
    const renderer = new FakeOwnerWebContents(1);
    const guest = new FakeBrowserGuest(501, renderer, profileSession);

    registerAttachedPaseoBrowser({
      browserId: "browser-cleanup",
      workspaceId: "workspace-cleanup",
      webContentsId: guest.id,
      sender: renderer,
      profileSession,
      findWebContents: () => guest,
    });

    expect(guest.backgroundThrottlingCalls).toEqual([false]);
    expect(getPaseoBrowserIdForWebContents(guest)).toBe("browser-cleanup");

    guest.destroy();

    expect(getPaseoBrowserIdForWebContents(guest)).toBeNull();
    expect(guest.backgroundThrottlingCalls).toEqual([false]);
  });

  test("tracks owner WebContents ID and supports verification", () => {
    const profileSession = {};
    const owner = new FakeOwnerWebContents(43);
    const contents = new FakeBrowserGuest(9002, owner, profileSession);

    registerAttachedPaseoBrowser({
      browserId: "browser-owner-test",
      workspaceId: "workspace-owner-test",
      webContentsId: contents.id,
      sender: owner,
      profileSession,
      findWebContents: () => contents,
    });

    expect(getPaseoBrowserOwnerWebContentsId("browser-owner-test")).toBe(43);

    contents.destroy();
    expect(getPaseoBrowserOwnerWebContentsId("browser-owner-test")).toBeNull();
  });

  test("sends found-in-page result to owner with browserId", () => {
    const profileSession = {};
    const owner = new FakeOwnerWebContents(44);
    const contents = new FakeBrowserGuest(9003, owner, profileSession);

    registerAttachedPaseoBrowser({
      browserId: "browser-a",
      workspaceId: "workspace-a",
      webContentsId: contents.id,
      sender: owner,
      profileSession,
      findWebContents: () => contents,
    });

    contents.triggerFoundInPage({
      requestId: 123,
      activeMatchOrdinal: 2,
      matches: 5,
      finalUpdate: true,
    });

    expect(owner.sentEvents).toHaveLength(1);
    expect(owner.sentEvents[0].channel).toBe(BROWSER_FOUND_IN_PAGE_EVENT);
    expect(owner.sentEvents[0].args[0]).toEqual({
      browserId: "browser-a",
      requestId: 123,
      activeMatchOrdinal: 2,
      matches: 5,
      finalUpdate: true,
    });
  });

  test("removes listeners on guest destruction", () => {
    const profileSession = {};
    const owner = new FakeOwnerWebContents(45);
    const contents = new FakeBrowserGuest(9004, owner, profileSession);

    registerAttachedPaseoBrowser({
      browserId: "browser-clean-guest",
      workspaceId: "workspace-clean-guest",
      webContentsId: contents.id,
      sender: owner,
      profileSession,
      findWebContents: () => contents,
    });
    contents.destroy();

    expect(contents.removedListeners).toContain("found-in-page");
  });

  test("removes listeners on owner did-start-navigation (reload)", () => {
    const profileSession = {};
    const owner = new FakeOwnerWebContents(46);
    const contents = new FakeBrowserGuest(9005, owner, profileSession);

    registerAttachedPaseoBrowser({
      browserId: "browser-clean-owner",
      workspaceId: "workspace-clean-owner",
      webContentsId: contents.id,
      sender: owner,
      profileSession,
      findWebContents: () => contents,
    });
    owner.navigate("https://another.com", true);

    expect(contents.removedListeners).toContain("found-in-page");
    expect(getPaseoBrowserOwnerWebContentsId("browser-clean-owner")).toBeNull();
  });

  test("does not add a second find listener when the same guest re-registers", () => {
    const profileSession = {};
    const owner = new FakeOwnerWebContents(47);
    const guest = new FakeBrowserGuest(9006, owner, profileSession);
    const input = {
      browserId: "browser-repeat",
      workspaceId: "workspace-repeat",
      webContentsId: guest.id,
      sender: owner,
      profileSession,
      findWebContents: () => guest,
    };

    expect(registerAttachedPaseoBrowser(input)).toBe(true);
    expect(registerAttachedPaseoBrowser(input)).toBe(true);
    expect(guest.foundInPageListenerCount).toBe(1);

    guest.triggerFoundInPage({
      requestId: 1,
      activeMatchOrdinal: 1,
      matches: 1,
      finalUpdate: true,
    });
    expect(owner.sentEvents).toHaveLength(1);
  });

  test("stops forwarding from the old owner when another window re-registers the browser", () => {
    const profileSession = {};
    const oldOwner = new FakeOwnerWebContents(48);
    const newOwner = new FakeOwnerWebContents(49);
    const oldGuest = new FakeBrowserGuest(9007, oldOwner, profileSession);
    const newGuest = new FakeBrowserGuest(9008, newOwner, profileSession);
    const guests = new Map([
      [oldGuest.id, oldGuest],
      [newGuest.id, newGuest],
    ]);

    expect(
      registerAttachedPaseoBrowser({
        browserId: "browser-reassigned",
        workspaceId: "workspace-a",
        webContentsId: oldGuest.id,
        sender: oldOwner,
        profileSession,
        findWebContents: (id) => guests.get(id) ?? null,
      }),
    ).toBe(true);
    expect(
      registerAttachedPaseoBrowser({
        browserId: "browser-reassigned",
        workspaceId: "workspace-b",
        webContentsId: newGuest.id,
        sender: newOwner,
        profileSession,
        findWebContents: (id) => guests.get(id) ?? null,
      }),
    ).toBe(true);

    oldGuest.triggerFoundInPage({
      requestId: 1,
      activeMatchOrdinal: 1,
      matches: 1,
      finalUpdate: true,
    });
    newGuest.triggerFoundInPage({
      requestId: 2,
      activeMatchOrdinal: 1,
      matches: 1,
      finalUpdate: true,
    });

    expect(oldOwner.sentEvents).toHaveLength(0);
    expect(newOwner.sentEvents).toHaveLength(1);
  });

  test("disposes the find listener when the browser unregisters", () => {
    const profileSession = {};
    const owner = new FakeOwnerWebContents(50);
    const guest = new FakeBrowserGuest(9009, owner, profileSession);

    registerAttachedPaseoBrowser({
      browserId: "browser-unregister",
      workspaceId: "workspace-unregister",
      webContentsId: guest.id,
      sender: owner,
      profileSession,
      findWebContents: () => guest,
    });
    unregisterPaseoBrowser("browser-unregister");

    expect(guest.foundInPageListenerCount).toBe(0);
    expect(guest.removedListeners).toContain("found-in-page");
  });
});
