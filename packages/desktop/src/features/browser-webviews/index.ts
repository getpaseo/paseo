import { webContents as allWebContents, type WebContents } from "electron";
import {
  BROWSER_NEW_TAB_REQUEST_EVENT,
  handleBrowserWindowOpenRequest,
  isAllowedBrowserWebviewUrl,
} from "./window-open.js";

export { BROWSER_NEW_TAB_REQUEST_EVENT, handleBrowserWindowOpenRequest };

const browserIdsByWebContentsId = new Map<number, string>();
const workspaceIdsByBrowserId = new Map<string, string>();
const activeBrowserIdsByWorkspaceId = new Map<string, string>();

export interface BrowserWorkspaceRegistration {
  browserId: string;
  workspaceId: string;
}

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
  return Array.from(new Set(browserIdsByWebContentsId.values())).sort();
}

export function registerPaseoBrowserWebContents(contents: WebContents, browserId: string): void {
  browserIdsByWebContentsId.set(contents.id, browserId);
  contents.once("destroyed", () => {
    browserIdsByWebContentsId.delete(contents.id);
    workspaceIdsByBrowserId.delete(browserId);
    for (const [workspaceId, activeBrowserId] of activeBrowserIdsByWorkspaceId) {
      if (activeBrowserId === browserId) {
        activeBrowserIdsByWorkspaceId.delete(workspaceId);
      }
    }
  });
}

export function getPaseoBrowserIdForWebContents(contents: WebContents | null): string | null {
  if (!contents || contents.isDestroyed()) {
    return null;
  }
  return browserIdsByWebContentsId.get(contents.id) ?? null;
}

export function registerPaseoBrowserWorkspace(input: BrowserWorkspaceRegistration): void {
  workspaceIdsByBrowserId.set(input.browserId, input.workspaceId);
}

export function getPaseoBrowserWorkspaceId(browserId: string): string | null {
  return workspaceIdsByBrowserId.get(browserId) ?? null;
}

export function listRegisteredPaseoBrowserIdsForWorkspace(workspaceId: string): string[] {
  return listRegisteredPaseoBrowserIds().filter(
    (browserId) => workspaceIdsByBrowserId.get(browserId) === workspaceId,
  );
}

export function setWorkspaceActivePaseoBrowserId(input: {
  workspaceId: string;
  browserId: string | null;
}): void {
  if (input.browserId) {
    workspaceIdsByBrowserId.set(input.browserId, input.workspaceId);
    activeBrowserIdsByWorkspaceId.delete(input.workspaceId);
    activeBrowserIdsByWorkspaceId.set(input.workspaceId, input.browserId);
    return;
  }
  activeBrowserIdsByWorkspaceId.delete(input.workspaceId);
}

export function getWorkspaceActivePaseoBrowserId(workspaceId: string): string | null {
  return activeBrowserIdsByWorkspaceId.get(workspaceId) ?? null;
}

export function getPaseoBrowserWebContents(browserId: string): WebContents | null {
  for (const [contentsId, registeredBrowserId] of browserIdsByWebContentsId) {
    if (registeredBrowserId !== browserId) continue;
    const contents = allWebContents.fromId(contentsId);
    if (contents && !contents.isDestroyed()) {
      return contents;
    }
  }
  return null;
}

export function getWorkspaceActivePaseoBrowserWebContents(workspaceId: string): WebContents | null {
  const activeBrowserId = getWorkspaceActivePaseoBrowserId(workspaceId);
  if (!activeBrowserId) {
    return null;
  }
  return getPaseoBrowserWebContents(activeBrowserId);
}

export function getMostRecentWorkspaceActivePaseoBrowserWebContents(): WebContents | null {
  const activeBrowserIds = Array.from(activeBrowserIdsByWorkspaceId.values());
  const browserId = activeBrowserIds.at(-1);
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
