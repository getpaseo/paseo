import { webContents as allWebContents, type WebContents } from "electron";
import {
  BROWSER_NEW_TAB_REQUEST_EVENT,
  handleBrowserWindowOpenRequest,
  isAllowedBrowserWebviewUrl,
} from "./window-open.js";
import { PaseoBrowserWebviewRegistry, type BrowserWorkspaceRegistration } from "./registry.js";

export { BROWSER_NEW_TAB_REQUEST_EVENT, handleBrowserWindowOpenRequest };
export type { BrowserWorkspaceRegistration };

const browserRegistry = new PaseoBrowserWebviewRegistry();

function getBrowserIdFromWebviewPartition(partition: string | undefined): string | null {
  const prefix = "persist:paseo-browser-";
  if (!partition?.startsWith(prefix)) {
    return null;
  }
  const browserId = partition.slice(prefix.length).trim();
  return browserId.length > 0 ? browserId : null;
}

export function readBrowserIdFromWebviewAttach(input: {
  src?: string;
  partition?: string;
}): string | null {
  if (!isAllowedBrowserWebviewUrl(input.src)) {
    return null;
  }
  return getBrowserIdFromWebviewPartition(input.partition);
}

export function listRegisteredPaseoBrowserIds(): string[] {
  return browserRegistry
    .listBrowserIds()
    .filter((browserId) => getPaseoBrowserWebContents(browserId));
}

export function registerPaseoBrowserWebContents(contents: WebContents, browserId: string): void {
  browserRegistry.registerWebContents({ webContentsId: contents.id, browserId });
  contents.once("destroyed", () => {
    browserRegistry.unregisterWebContents(contents.id);
  });
}

export function getPaseoBrowserIdForWebContents(contents: WebContents | null): string | null {
  if (!contents || contents.isDestroyed()) {
    return null;
  }
  return browserRegistry.getBrowserIdForWebContents(contents.id);
}

export function registerPaseoBrowserWorkspace(input: BrowserWorkspaceRegistration): void {
  browserRegistry.registerWorkspace(input);
}

export function getPaseoBrowserWorkspaceId(browserId: string): string | null {
  return browserRegistry.getWorkspaceId(browserId);
}

export function listRegisteredPaseoBrowserIdsForWorkspace(workspaceId: string): string[] {
  return browserRegistry
    .listBrowserIdsForWorkspace(workspaceId)
    .filter((browserId) => getPaseoBrowserWebContents(browserId));
}

export function setWorkspaceActivePaseoBrowserId(input: {
  workspaceId: string;
  browserId: string | null;
}): void {
  browserRegistry.setWorkspaceActiveBrowser(input);
}

export function getWorkspaceActivePaseoBrowserId(workspaceId: string): string | null {
  return browserRegistry.getWorkspaceActiveBrowserId(workspaceId);
}

export function getPaseoBrowserWebContents(browserId: string): WebContents | null {
  const contentsId = browserRegistry.getWebContentsIdForBrowser(browserId);
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

export function getMostRecentWorkspaceActivePaseoBrowserWebContents(): WebContents | null {
  const browserId = browserRegistry.getMostRecentWorkspaceActiveBrowserId();
  return browserId ? getPaseoBrowserWebContents(browserId) : null;
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
