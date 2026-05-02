import { webContents as allWebContents, type WebContents } from "electron";

export const BROWSER_FOUND_IN_PAGE_EVENT = "paseo:event:browser-found-in-page";

const browserIdsByWebContentsId = new Map<number, string>();
const webContentsIdsByBrowserId = new Map<string, number>();
const ownerWebContentsIdsByBrowserId = new Map<string, number>();
const activeFindBrowserIdsByOwnerWebContentsId = new Map<number, string>();
const ownerFoundInPageListenerWebContentsIds = new Set<number>();
let activeBrowserPaneId: string | null = null;

function ensureOwnerFoundInPageListener(ownerContents: WebContents): void {
  if (ownerFoundInPageListenerWebContentsIds.has(ownerContents.id)) {
    return;
  }
  ownerFoundInPageListenerWebContentsIds.add(ownerContents.id);
  const handleFoundInPage = (_event: Electron.Event, result: Electron.Result): void => {
    const browserId = activeFindBrowserIdsByOwnerWebContentsId.get(ownerContents.id);
    if (!browserId || ownerContents.isDestroyed()) {
      return;
    }
    ownerContents.send(BROWSER_FOUND_IN_PAGE_EVENT, {
      browserId,
      requestId: result.requestId,
      activeMatchOrdinal: result.activeMatchOrdinal,
      matches: result.matches,
      finalUpdate: result.finalUpdate,
    });
    if (result.finalUpdate) {
      activeFindBrowserIdsByOwnerWebContentsId.delete(ownerContents.id);
    }
  };
  ownerContents.on("found-in-page", handleFoundInPage);
  ownerContents.once("destroyed", () => {
    ownerContents.removeListener("found-in-page", handleFoundInPage);
    ownerFoundInPageListenerWebContentsIds.delete(ownerContents.id);
    activeFindBrowserIdsByOwnerWebContentsId.delete(ownerContents.id);
  });
}

export function registerPaseoBrowserWebContents(
  contents: WebContents,
  browserId: string,
  ownerContents?: WebContents,
): void {
  browserIdsByWebContentsId.set(contents.id, browserId);
  webContentsIdsByBrowserId.set(browserId, contents.id);
  if (ownerContents && !ownerContents.isDestroyed()) {
    ownerWebContentsIdsByBrowserId.set(browserId, ownerContents.id);
    ensureOwnerFoundInPageListener(ownerContents);
  }
  contents.once("destroyed", () => {
    browserIdsByWebContentsId.delete(contents.id);
    if (webContentsIdsByBrowserId.get(browserId) === contents.id) {
      webContentsIdsByBrowserId.delete(browserId);
      const ownerContentsId = ownerWebContentsIdsByBrowserId.get(browserId);
      ownerWebContentsIdsByBrowserId.delete(browserId);
      if (
        ownerContentsId &&
        activeFindBrowserIdsByOwnerWebContentsId.get(ownerContentsId) === browserId
      ) {
        activeFindBrowserIdsByOwnerWebContentsId.delete(ownerContentsId);
      }
    }
    if (activeBrowserPaneId === browserId) {
      activeBrowserPaneId = null;
    }
  });
}

export function getPaseoBrowserIdForWebContents(contents: WebContents | null): string | null {
  if (!contents || contents.isDestroyed()) {
    return null;
  }
  return browserIdsByWebContentsId.get(contents.id) ?? null;
}

export function setActivePaseoBrowserPaneId(browserId: string | null): void {
  activeBrowserPaneId = browserId;
}

export function getPaseoBrowserWebContents(browserId: string): WebContents | null {
  const contentsId = webContentsIdsByBrowserId.get(browserId);
  if (!contentsId) {
    return null;
  }
  const contents = allWebContents.fromId(contentsId);
  return contents && !contents.isDestroyed() ? contents : null;
}

export function setActivePaseoBrowserFind(browserId: string): boolean {
  const ownerContentsId = ownerWebContentsIdsByBrowserId.get(browserId);
  if (!ownerContentsId) {
    return false;
  }
  const ownerContents = allWebContents.fromId(ownerContentsId);
  if (!ownerContents || ownerContents.isDestroyed()) {
    return false;
  }
  ensureOwnerFoundInPageListener(ownerContents);
  activeFindBrowserIdsByOwnerWebContentsId.set(ownerContents.id, browserId);
  return true;
}

export function clearActivePaseoBrowserFind(browserId: string): void {
  const ownerContentsId = ownerWebContentsIdsByBrowserId.get(browserId);
  if (!ownerContentsId) {
    return;
  }
  if (activeFindBrowserIdsByOwnerWebContentsId.get(ownerContentsId) === browserId) {
    activeFindBrowserIdsByOwnerWebContentsId.delete(ownerContentsId);
  }
}

export function getActivePaseoBrowserWebContents(): WebContents | null {
  if (!activeBrowserPaneId) {
    return null;
  }
  for (const [contentsId, browserId] of browserIdsByWebContentsId) {
    if (browserId !== activeBrowserPaneId) continue;
    const contents = allWebContents.fromId(contentsId);
    if (contents && !contents.isDestroyed()) {
      return contents;
    }
  }
  return null;
}
