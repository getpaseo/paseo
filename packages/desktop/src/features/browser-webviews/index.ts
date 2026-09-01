import { webContents as allWebContents, type WebContents } from "electron";
import { PASEO_BROWSER_PROFILE_PARTITION } from "../browser-profile.js";
import {
  BROWSER_NEW_TAB_REQUEST_EVENT,
  decideBrowserWindowOpenRequest,
  isAllowedBrowserWebviewUrl,
  PendingBrowserWindowOpenRequests,
} from "./window-open.js";
import { PaseoBrowserWebviewRegistry } from "./registry.js";
import {
  guestCompositor,
  setupGuestCompositorWatchdog,
  type GuestCompositorTarget,
  type GuestProcessMetric,
} from "./guest-compositor.js";

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

interface RegisteredBrowserWebContents extends BrowserWebContentsIdentity {
  readonly hostWebContents: BrowserWebContentsIdentity | null;
  readonly session: object;
  once(event: "destroyed", listener: () => void): void;
}

interface AttachedBrowserRegistration {
  browserId: string;
  workspaceId: string;
  webContentsId: number;
}

interface RegisterAttachedBrowserInput extends AttachedBrowserRegistration {
  sender: BrowserWebContentsIdentity;
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

function getGuestCompositorContents(webContentsId: number): GuestCompositorTarget | null {
  const contents = allWebContents?.fromId?.(webContentsId);
  if (!contents || contents.isDestroyed()) {
    return null;
  }
  return contents;
}

export function syncPaseoGuestCompositorBudgets(): Promise<void> {
  return guestCompositor.applyBudgets({
    guests: browserRegistry.listRegistrations(),
    getContents: getGuestCompositorContents,
  });
}

function queueGuestCompositorSync(): void {
  void syncPaseoGuestCompositorBudgets().catch((error) => {
    console.warn("[guest-compositor] failed to apply budgets", error);
  });
}

export async function withPaseoGuestLiveHold<T>(
  webContentsId: number,
  task: () => Promise<T>,
): Promise<T> {
  try {
    return await guestCompositor.withLiveHold(webContentsId, async () => {
      await syncPaseoGuestCompositorBudgets();
      return await task();
    });
  } finally {
    await syncPaseoGuestCompositorBudgets();
  }
}

export function setPaseoGuestPresented(input: {
  hostWebContentsId: number;
  browserId: string;
  presented: boolean;
}): void {
  guestCompositor.setPresented(input);
  queueGuestCompositorSync();
}

export function startPaseoGuestCompositorWatchdog(input: {
  getMetrics: () => GuestProcessMetric[];
}): () => void {
  return setupGuestCompositorWatchdog({
    listGuests: () => browserRegistry.listRegistrations(),
    getContents: getGuestCompositorContents,
    getMetrics: input.getMetrics,
  });
}

export function preparePaseoBrowserWebContents(contents: RegisteredBrowserWebContents): void {
  const webContentsId = contents.id;
  // Preserve Chromium throttling when the host window is hidden. Browser
  // residency and screenshot capture do not require a lifetime override.
  contents.once("destroyed", () => {
    browserRegistry.unregisterWebContents(webContentsId);
    guestCompositor.releaseWebContents(webContentsId);
    queueGuestCompositorSync();
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

  browserRegistry.registerWebContents({
    webContentsId: input.webContentsId,
    browserId: input.browserId,
    hostWebContentsId: input.sender.id,
  });
  browserRegistry.registerWorkspace({
    browserId: input.browserId,
    workspaceId: input.workspaceId,
  });
  queueGuestCompositorSync();
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
  const registrations = browserRegistry
    .listRegistrations()
    .filter((registration) => registration.browserId === browserId);
  browserRegistry.unregisterBrowser(browserId);
  for (const registration of registrations) {
    guestCompositor.releaseWebContents(registration.webContentsId);
  }
  queueGuestCompositorSync();
}

export function unregisterPaseoBrowserFromHost(hostWebContentsId: number, browserId: string): void {
  const webContentsId = browserRegistry.getWebContentsIdForBrowserInHostWindow(
    hostWebContentsId,
    browserId,
  );
  browserRegistry.unregisterBrowserFromHost(hostWebContentsId, browserId);
  if (webContentsId !== null) {
    guestCompositor.releaseWebContents(webContentsId);
  }
  queueGuestCompositorSync();
}

export function unregisterPaseoBrowserHost(hostWebContentsId: number): void {
  const registrations = browserRegistry
    .listRegistrations()
    .filter((registration) => registration.hostWebContentsId === hostWebContentsId);
  browserRegistry.unregisterHostWebContents(hostWebContentsId);
  for (const registration of registrations) {
    guestCompositor.releaseWebContents(registration.webContentsId);
  }
  guestCompositor.releaseHost(hostWebContentsId);
  queueGuestCompositorSync();
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
  guestCompositor.setActive({
    hostWebContentsId: input.hostWebContentsId,
    browserId: browserRegistry.getActiveBrowserIdForHostWindow(input.hostWebContentsId),
  });
  queueGuestCompositorSync();
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
