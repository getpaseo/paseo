import { webContents as allWebContents, type WebContents } from "electron";
import { PASEO_BROWSER_PROFILE_PARTITION } from "../browser-profile.js";
import {
  BROWSER_NEW_TAB_REQUEST_EVENT,
  decideBrowserWindowOpenRequest,
  isAllowedBrowserWebviewUrl,
  PendingBrowserWindowOpenRequests,
} from "./window-open.js";
import { PaseoBrowserWebviewRegistry } from "./registry.js";

export {
  BROWSER_NEW_TAB_REQUEST_EVENT,
  decideBrowserWindowOpenRequest,
  PendingBrowserWindowOpenRequests,
};

const browserRegistry = new PaseoBrowserWebviewRegistry();

interface BrowserWebContentsIdentity {
  readonly id: number;
  isDestroyed(): boolean;
}

interface BrowserOwnerWebContents extends BrowserWebContentsIdentity {
  send(channel: string, ...args: unknown[]): void;
  once(event: "destroyed", listener: () => void): void;
  on(
    event: "did-start-navigation",
    listener: (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void,
  ): void;
  removeListener(event: "destroyed", listener: () => void): void;
  removeListener(
    event: "did-start-navigation",
    listener: (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void,
  ): void;
}

interface RegisteredBrowserWebContents extends BrowserWebContentsIdentity {
  readonly hostWebContents: BrowserWebContentsIdentity | null;
  readonly session: object;
  setBackgroundThrottling(allowed: boolean): void;
  once(event: "destroyed", listener: () => void): void;
  on(event: "found-in-page", listener: (event: unknown, result: unknown) => void): void;
  removeListener(event: "found-in-page", listener: (event: unknown, result: unknown) => void): void;
}

interface AttachedBrowserRegistration {
  browserId: string;
  workspaceId: string;
  webContentsId: number;
}

interface RegisterAttachedBrowserInput extends AttachedBrowserRegistration {
  sender: BrowserOwnerWebContents;
  profileSession: object;
  findWebContents(webContentsId: number): RegisteredBrowserWebContents | null;
}

export function isPaseoBrowserWebviewAttach(input: { src?: string; partition?: string }): boolean {
  return (
    isAllowedBrowserWebviewUrl(input.src) && input.partition === PASEO_BROWSER_PROFILE_PARTITION
  );
}

export function listRegisteredPaseoBrowserIds(): string[] {
  return browserRegistry.listBrowserIds();
}

export function getPaseoBrowserWebviewRegistry(): PaseoBrowserWebviewRegistry {
  return browserRegistry;
}

export const BROWSER_FOUND_IN_PAGE_EVENT = "paseo:event:browser-found-in-page";

interface BrowserGuestFindInPageWire {
  readonly browserId: string;
  readonly webContentsId: number;
  cleanup(): void;
}

// Keyed by the guest webContentsId only: main's registry allows the same browserId to be
// attached in several host windows at once, so a browserId no longer identifies a single wire.
const browserGuestFindInPageWiresByWebContentsId = new Map<number, BrowserGuestFindInPageWire>();

function disposePaseoBrowserGuestFindInPageWire(
  wire: BrowserGuestFindInPageWire | undefined,
): void {
  wire?.cleanup();
}

function disposePaseoBrowserGuestFindInPageWiresForBrowser(browserId: string): void {
  for (const wire of Array.from(browserGuestFindInPageWiresByWebContentsId.values())) {
    if (wire.browserId === browserId) {
      disposePaseoBrowserGuestFindInPageWire(wire);
    }
  }
}

function disposePaseoBrowserGuestFindInPageWiresForHost(hostWebContentsId: number): void {
  for (const wire of Array.from(browserGuestFindInPageWiresByWebContentsId.values())) {
    const registration = browserRegistry.getRegistrationForWebContents(wire.webContentsId);
    if (registration?.hostWebContentsId === hostWebContentsId) {
      disposePaseoBrowserGuestFindInPageWire(wire);
    }
  }
}

function wirePaseoBrowserGuestFindInPage(
  contents: RegisteredBrowserWebContents,
  browserId: string,
  ownerContents: BrowserOwnerWebContents,
): BrowserGuestFindInPageWire {
  let cleaned = false;
  const handleFoundInPage = (_event: unknown, result: unknown): void => {
    if (ownerContents.isDestroyed()) {
      cleanup();
      return;
    }
    const registration = browserRegistry.getRegistrationForWebContents(contents.id);
    if (!registration || registration.hostWebContentsId !== ownerContents.id) {
      return;
    }
    const res = result as {
      requestId: number;
      activeMatchOrdinal: number;
      matches: number;
      finalUpdate: boolean;
    };
    ownerContents.send(BROWSER_FOUND_IN_PAGE_EVENT, {
      browserId,
      requestId: res.requestId,
      activeMatchOrdinal: res.activeMatchOrdinal,
      matches: res.matches,
      finalUpdate: res.finalUpdate,
    });
  };

  const cleanup = (): void => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    contents.removeListener("found-in-page", handleFoundInPage);
    ownerContents.removeListener("destroyed", cleanup);
    ownerContents.removeListener("did-start-navigation", handleOwnerNavigate);
    if (browserGuestFindInPageWiresByWebContentsId.get(contents.id)?.cleanup === cleanup) {
      browserGuestFindInPageWiresByWebContentsId.delete(contents.id);
    }
    browserRegistry.unregisterWebContents(contents.id);
  };

  const handleOwnerNavigate = (
    _event: unknown,
    _url: string,
    _isInPlace: boolean,
    isMainFrame: boolean,
  ): void => {
    if (isMainFrame) {
      cleanup();
    }
  };

  const wire: BrowserGuestFindInPageWire = {
    browserId,
    webContentsId: contents.id,
    cleanup,
  };
  contents.on("found-in-page", handleFoundInPage);

  // Guard against window closed or reloaded
  ownerContents.once("destroyed", cleanup);
  ownerContents.on("did-start-navigation", handleOwnerNavigate);
  browserGuestFindInPageWiresByWebContentsId.set(contents.id, wire);
  return wire;
}

export function preparePaseoBrowserWebContents(contents: RegisteredBrowserWebContents): void {
  const webContentsId = contents.id;
  contents.setBackgroundThrottling(false);
  contents.once("destroyed", () => {
    disposePaseoBrowserGuestFindInPageWire(
      browserGuestFindInPageWiresByWebContentsId.get(webContentsId),
    );
    browserRegistry.unregisterWebContents(webContentsId);
  });
}

export function registerAttachedPaseoBrowser(input: RegisterAttachedBrowserInput): boolean {
  const guest = input.findWebContents(input.webContentsId);
  if (
    !guest ||
    guest.isDestroyed() ||
    guest.hostWebContents !== input.sender ||
    guest.session !== input.profileSession
  ) {
    return false;
  }

  disposePaseoBrowserGuestFindInPageWire(
    browserGuestFindInPageWiresByWebContentsId.get(input.webContentsId),
  );

  browserRegistry.registerWebContents({
    webContentsId: input.webContentsId,
    browserId: input.browserId,
    hostWebContentsId: input.sender.id,
  });
  browserRegistry.registerWorkspace({
    browserId: input.browserId,
    workspaceId: input.workspaceId,
  });
  wirePaseoBrowserGuestFindInPage(guest, input.browserId, input.sender);
  return true;
}

export function getPaseoBrowserIdForWebContents(
  contents: BrowserWebContentsIdentity | null,
): string | null {
  if (!contents || contents.isDestroyed()) {
    return null;
  }
  return browserRegistry.getBrowserIdForWebContents(contents.id);
}

export function unregisterPaseoBrowser(browserId: string): void {
  disposePaseoBrowserGuestFindInPageWiresForBrowser(browserId);
  browserRegistry.unregisterBrowser(browserId);
}

export function unregisterPaseoBrowserFromHost(hostWebContentsId: number, browserId: string): void {
  const webContentsId = browserRegistry.getWebContentsIdForBrowserInHostWindow(
    hostWebContentsId,
    browserId,
  );
  if (webContentsId !== null) {
    disposePaseoBrowserGuestFindInPageWire(
      browserGuestFindInPageWiresByWebContentsId.get(webContentsId),
    );
  }
  browserRegistry.unregisterBrowserFromHost(hostWebContentsId, browserId);
}

export function unregisterPaseoBrowserHost(hostWebContentsId: number): void {
  disposePaseoBrowserGuestFindInPageWiresForHost(hostWebContentsId);
  browserRegistry.unregisterHostWebContents(hostWebContentsId);
}

export function getPaseoBrowserWorkspaceId(browserId: string): string | null {
  return browserRegistry.getWorkspaceId(browserId);
}

export function listRegisteredPaseoBrowserIdsForWorkspace(workspaceId: string): string[] {
  return browserRegistry.listBrowserIdsForWorkspace(workspaceId);
}

export function setWorkspaceActivePaseoBrowserId(input: {
  hostWebContentsId: number;
  workspaceId: string;
  browserId: string | null;
}): void {
  browserRegistry.setWorkspaceActiveBrowser(input);
}

export function getWorkspaceActivePaseoBrowserId(workspaceId: string): string | null {
  return browserRegistry.getMostRecentActiveBrowserIdForWorkspace(workspaceId);
}

export function getWorkspaceActivePaseoBrowserIdForHostWindow(
  workspaceId: string,
  hostWebContentsId: number,
): string | null {
  return browserRegistry.getActiveBrowserIdForWorkspaceInHostWindow(hostWebContentsId, workspaceId);
}

export function getPaseoBrowserWebContentsForHostWindow(
  browserId: string,
  hostWebContentsId: number,
): WebContents | null {
  const contentsId = browserRegistry.getWebContentsIdForBrowserInHostWindow(
    hostWebContentsId,
    browserId,
  );
  if (contentsId === null) {
    return null;
  }
  const contents = allWebContents.fromId(contentsId);
  if (contents && !contents.isDestroyed()) {
    return contents;
  }
  browserRegistry.unregisterWebContents(contentsId);
  return null;
}

export function getActivePaseoBrowserWebContentsForHostWindow(
  hostWebContentsId: number,
): WebContents | null {
  const browserId = browserRegistry.getActiveBrowserIdForHostWindow(hostWebContentsId);
  if (!browserId) {
    return null;
  }
  const contentsId = browserRegistry.getWebContentsIdForBrowserInHostWindow(
    hostWebContentsId,
    browserId,
  );
  if (contentsId === null) {
    return null;
  }
  const contents = allWebContents.fromId(contentsId);
  if (contents && !contents.isDestroyed()) {
    return contents;
  }
  browserRegistry.unregisterWebContents(contentsId);
  return null;
}

function preventUnsafeBrowserWebviewNavigation(
  event: { preventDefault: () => void },
  url: string | undefined,
): void {
  if (!isAllowedBrowserWebviewUrl(url)) {
    event.preventDefault();
  }
}

export function registerBrowserWebviewNavigationGuards(contents: WebContents): void {
  contents.on("will-navigate", (event) => {
    preventUnsafeBrowserWebviewNavigation(event, event.url);
  });
  contents.on("will-frame-navigate", (event) => {
    preventUnsafeBrowserWebviewNavigation(event, event.url);
  });
  contents.on("will-redirect", (event) => {
    preventUnsafeBrowserWebviewNavigation(event, event.url);
  });
}
