import { useNetworkRoutingStatus } from "./network-routing/status";
import { isWeb } from "@/constants/platform";
import {
  ROUTED_BROWSER_PARTITION_PREFIX,
  resolveBrowserPartition,
  providerReadySchema,
  routingChangedSchema,
  routingDesktop,
} from "./network-routing/contract";
import {
  getDesktopHost,
  type DesktopAttachedBrowserRegistration,
  type DesktopBrowserBridge,
} from "@/desktop/host";
import type { BrowserViewport } from "@/desktop/browser/store";
import { WEB_SURFACE_PLANE } from "@/lib/overlay-root";

const RESIDENT_BROWSER_HOST_ID = "paseo-browser-resident-webviews";
const BROWSER_ID_ATTRIBUTE = "data-paseo-browser-id";
const BROWSER_SURFACE_ATTRIBUTE = "data-paseo-browser-surface";
const RESIDENT_VIEWPORT_WIDTH = 1280;
const RESIDENT_VIEWPORT_HEIGHT = 800;

const residentWebviewsByBrowserId = new Map<string, HTMLElement>();
const retiredWebviews = new WeakSet<HTMLElement>();
// Every guest listener a webview owns hangs off one controller, so retiring the element
// drops them all at once instead of trusting each handler to notice it is stale.
const webviewListenerControllers = new WeakMap<HTMLElement, AbortController>();
// The dom-ready fallback a did-attach left behind, if any: it belongs to that guest only.
const pendingAttachFallbacks = new WeakMap<HTMLElement, AbortController>();
const residentSurfacesByBrowserId = new Map<string, HTMLElement>();
const residentWebviewSizesByBrowserId = new Map<string, { width: number; height: number }>();

interface BrowserWebviewElement extends HTMLElement {
  src: string;
  getWebContentsId(): number;
}

interface BrowserWebviewIdentity {
  browserId: string;
  workspaceId: string;
  serverId: string;
}

export interface BrowserWebviewProfileHost {
  profilePartition: string;
  resolvePartition?: (serverId: string, sharedPartition: string) => Promise<string>;
  registerAttachedBrowser(input: DesktopAttachedBrowserRegistration): Promise<void>;
}

function isAttachedBrowserBridge(
  browser: DesktopBrowserBridge | undefined,
): browser is BrowserWebviewProfileHost {
  return (
    browser !== undefined &&
    typeof browser.profilePartition === "string" &&
    browser.profilePartition.startsWith("persist:") &&
    typeof browser.registerAttachedBrowser === "function"
  );
}

function getBrowserBridge(override?: BrowserWebviewProfileHost): BrowserWebviewProfileHost {
  if (override) {
    return override;
  }
  const browser = getDesktopHost()?.browser;
  if (!isAttachedBrowserBridge(browser)) {
    throw new Error("Electron browser profile bridge is unavailable");
  }
  return browser;
}

function listenerSignal(webview: HTMLElement): AbortSignal {
  let controller = webviewListenerControllers.get(webview);
  if (!controller) {
    controller = new AbortController();
    webviewListenerControllers.set(webview, controller);
  }
  return controller.signal;
}

function retireBrowserWebview(webview: HTMLElement): void {
  retiredWebviews.add(webview);
  webviewListenerControllers.get(webview)?.abort();
  webview.remove();
}

// Electron's WEB_VIEW_ERROR_MESSAGES.NOT_ATTACHED, the only failure getWebContentsId() has
// while the element is attached: the guest id has not been recorded in the renderer yet.
const ELECTRON_WEBVIEW_NOT_ATTACHED = "The WebView must be attached to the DOM";

/**
 * The guest id the main process needs, or null while Electron has not recorded one yet.
 *
 * `did-attach` is emitted synchronously inside the same main-process call that answers
 * the webview's `createGuest`, but the event reaches the renderer over the guest event
 * channel and the answer over the invoke reply: two Mojo pipes with no ordering between
 * them. When the event wins, `getWebContentsId()` throws Electron's "must be attached
 * to the DOM and the dom-ready event emitted" error although the element is attached.
 * Reparenting widens the window: the element keeps its `viewInstanceId`, so a late
 * `did-attach` from the previous guest lands while the next guest is still being created.
 * That one error is the only signal Electron gives, so it is the only one caught here.
 */
function readAttachedWebContentsId(webview: BrowserWebviewElement): number | null {
  try {
    return webview.getWebContentsId();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(ELECTRON_WEBVIEW_NOT_ATTACHED)) {
      return null;
    }
    throw error;
  }
}

function registerBrowserWhenAttached(
  webview: BrowserWebviewElement,
  identity: BrowserWebviewIdentity,
  browser: BrowserWebviewProfileHost,
): void {
  const signal = listenerSignal(webview);
  const register = (): boolean => {
    if (retiredWebviews.has(webview) || !webview.isConnected) return true;
    const webContentsId = readAttachedWebContentsId(webview);
    if (webContentsId === null) return false;
    void browser
      .registerAttachedBrowser({
        browserId: identity.browserId,
        workspaceId: identity.workspaceId,
        webContentsId,
      })
      .catch((error) => {
        console.error("[browser-webview] attached registration failed", error);
      });
    return true;
  };
  // Reparenting a webview can replace its guest WebContents without replacing
  // this DOM element, so every attachment needs a fresh main-process registration.
  webview.addEventListener(
    "did-attach",
    () => {
      // Each attach starts a guest generation. A fallback left by the previous one would
      // register again, or register this generation's guest under the previous attach.
      dropPendingAttachFallback(webview);
      if (register()) return;
      // The guest id arrives with the createGuest reply, which dispatches nothing to the
      // element. `dom-ready` is the readiness point Electron names for this method, and
      // it needs a whole navigation, so it lands well after that reply.
      const fallback = new AbortController();
      pendingAttachFallbacks.set(webview, fallback);
      webview.addEventListener(
        "dom-ready",
        () => {
          pendingAttachFallbacks.delete(webview);
          register();
        },
        { once: true, signal: AbortSignal.any([signal, fallback.signal]) },
      );
    },
    { signal },
  );
}

function dropPendingAttachFallback(webview: HTMLElement): void {
  pendingAttachFallbacks.get(webview)?.abort();
  pendingAttachFallbacks.delete(webview);
}

/**
 * Moves a webview under `parent`, which detaches and reattaches it and so swaps its guest.
 * The swap starts here, before the next guest's did-attach arrives, and the next guest's
 * id can become readable before that event: a fallback still pending for the previous
 * guest would register it. Drop the fallback at the start of the swap.
 */
function attachWebviewTo(parent: HTMLElement, webview: HTMLElement): void {
  if (webview.parentElement === parent) return;
  dropPendingAttachFallback(webview);
  parent.appendChild(webview);
}

function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readDocument(): Document | null {
  if (!isWeb || typeof document === "undefined") return null;
  return document;
}

function applyResidentHostParkingStyle(host: HTMLElement): void {
  // The host is permanent. Individual browser surfaces switch between their
  // pane bounds and the proven paintable 1x1 parking geometry.
  host.removeAttribute("aria-hidden");
  host.style.position = "fixed";
  host.style.left = "0";
  host.style.top = "0";
  host.style.width = "100vw";
  host.style.height = "100vh";
  host.style.overflow = "visible";
  host.style.opacity = "1";
  host.style.pointerEvents = "none";
  host.style.display = "block";
  host.style.zIndex = String(WEB_SURFACE_PLANE.browser);
  host.style.clipPath = "";
  host.style.visibility = "visible";
  host.style.transform = "";
}

function applyParkedBrowserSurfaceStyle(surface: HTMLElement): void {
  surface.setAttribute("aria-hidden", "true");
  surface.style.position = "fixed";
  surface.style.left = "0";
  surface.style.top = "0";
  surface.style.width = "1px";
  surface.style.height = "1px";
  surface.style.overflow = "hidden";
  surface.style.opacity = "1";
  surface.style.pointerEvents = "none";
  surface.style.display = "block";
  surface.style.visibility = "visible";
  surface.style.transform = "";
}

function getBrowserSurface(browserId: string, ownerDocument: Document): HTMLElement {
  const existing = residentSurfacesByBrowserId.get(browserId);
  if (existing?.isConnected) {
    return existing;
  }
  const surface = ownerDocument.createElement("div");
  surface.setAttribute(BROWSER_SURFACE_ATTRIBUTE, browserId);
  applyParkedBrowserSurfaceStyle(surface);
  getResidentBrowserHost(ownerDocument).appendChild(surface);
  residentSurfacesByBrowserId.set(browserId, surface);
  return surface;
}

function getResidentBrowserHost(ownerDocument: Document): HTMLElement {
  const existing = ownerDocument.getElementById(RESIDENT_BROWSER_HOST_ID);
  if (existing) {
    applyResidentHostParkingStyle(existing);
    return existing;
  }

  const host = ownerDocument.createElement("div");
  host.id = RESIDENT_BROWSER_HOST_ID;
  applyResidentHostParkingStyle(host);
  ownerDocument.body.appendChild(host);
  return host;
}

function findBrowserWebview(browserId: string, ownerDocument: Document): HTMLElement | null {
  for (const element of ownerDocument.querySelectorAll(`[${BROWSER_ID_ATTRIBUTE}]`)) {
    if (!(element instanceof HTMLElement)) {
      continue;
    }
    if (element.getAttribute(BROWSER_ID_ATTRIBUTE) === browserId) {
      return element;
    }
  }
  return null;
}

function dimensionsForBrowser(browserId: string | null): { width: number; height: number } {
  if (!browserId) {
    return { width: RESIDENT_VIEWPORT_WIDTH, height: RESIDENT_VIEWPORT_HEIGHT };
  }
  return (
    residentWebviewSizesByBrowserId.get(browserId) ?? {
      width: RESIDENT_VIEWPORT_WIDTH,
      height: RESIDENT_VIEWPORT_HEIGHT,
    }
  );
}

function applyResidentWebviewStyle(webview: HTMLElement, browserId: string | null): void {
  const dimensions = dimensionsForBrowser(browserId);
  webview.style.display = "inline-flex";
  webview.style.flex = "0 0 auto";
  webview.style.width = `${dimensions.width}px`;
  webview.style.height = `${dimensions.height}px`;
  webview.style.border = "0";
  webview.style.background = "transparent";
  webview.style.position = "absolute";
  webview.style.left = "0";
  webview.style.top = "0";
  webview.style.marginTop = "0";
  webview.style.zIndex = "0";
}

function clearResidentWebviewParkingStyle(webview: HTMLElement): void {
  webview.style.position = "";
  webview.style.left = "";
  webview.style.top = "";
  webview.style.marginTop = "";
  webview.style.zIndex = "";
}

export function rememberBrowserWebviewSize(input: {
  browserId: string;
  width: number;
  height: number;
}): { width: number; height: number } | null {
  const browserId = trimNonEmpty(input.browserId);
  if (!browserId || input.width <= 0 || input.height <= 0) {
    return null;
  }
  const dimensions = {
    width: Math.max(1, Math.round(input.width)),
    height: Math.max(1, Math.round(input.height)),
  };
  residentWebviewSizesByBrowserId.set(browserId, dimensions);
  return dimensions;
}

function applyBrowserWebviewDimensions(
  webview: HTMLElement,
  dimensions: { width: number; height: number },
): void {
  webview.style.display = "flex";
  webview.style.border = "0";
  webview.style.background = "transparent";
  webview.style.flex = "0 0 auto";
  webview.style.width = `${Math.max(1, Math.round(dimensions.width))}px`;
  webview.style.height = `${Math.max(1, Math.round(dimensions.height))}px`;
}

export function applyInactiveBrowserWebviewViewport(
  browserId: string,
  webview: HTMLElement,
  viewport: BrowserViewport,
): void {
  if (viewport.mode === "fixed") {
    rememberBrowserWebviewSize({ browserId, width: viewport.width, height: viewport.height });
  }
  applyResidentWebviewStyle(webview, trimNonEmpty(browserId));
}

export function presentBrowserWebview(
  browserId: string,
  webview: HTMLElement,
  anchor: HTMLElement,
  clip: HTMLElement,
  viewport: BrowserViewport,
): void {
  if (retiredWebviews.has(webview)) return;
  const normalizedBrowserId = trimNonEmpty(browserId);
  if (!normalizedBrowserId) {
    return;
  }
  const ownerDocument = readDocument();
  if (!ownerDocument) {
    return;
  }
  const surface = getBrowserSurface(normalizedBrowserId, ownerDocument);
  attachWebviewTo(surface, webview);
  const anchorBounds = anchor.getBoundingClientRect();
  const clipBounds = clip.getBoundingClientRect();
  const left = Math.max(anchorBounds.left, clipBounds.left);
  const top = Math.max(anchorBounds.top, clipBounds.top);
  const right = Math.min(
    anchorBounds.left + anchorBounds.width,
    clipBounds.left + clipBounds.width,
  );
  const bottom = Math.min(
    anchorBounds.top + anchorBounds.height,
    clipBounds.top + clipBounds.height,
  );
  const surfaceLeft = Math.ceil(left);
  const surfaceTop = Math.ceil(top);
  const surfaceRight = Math.floor(right);
  const surfaceBottom = Math.floor(bottom);
  const hasVisibleArea = surfaceRight > surfaceLeft && surfaceBottom > surfaceTop;
  surface.setAttribute("aria-hidden", "false");
  surface.style.position = "fixed";
  surface.style.left = `${surfaceLeft}px`;
  surface.style.top = `${surfaceTop}px`;
  surface.style.width = `${Math.max(0, surfaceRight - surfaceLeft)}px`;
  surface.style.height = `${Math.max(0, surfaceBottom - surfaceTop)}px`;
  surface.style.overflow = "hidden";
  surface.style.opacity = "1";
  surface.style.pointerEvents = hasVisibleArea ? "auto" : "none";
  surface.style.display = "flex";
  surface.style.visibility = "visible";
  clearResidentWebviewParkingStyle(webview);
  applyBrowserWebviewDimensions(
    webview,
    viewport.mode === "responsive"
      ? { width: anchorBounds.width, height: anchorBounds.height }
      : viewport,
  );
  webview.style.position = "absolute";
  webview.style.left = `${Math.round(anchorBounds.left - surfaceLeft)}px`;
  webview.style.top = `${Math.round(anchorBounds.top - surfaceTop)}px`;
}

interface PrepareBrowserInput extends BrowserWebviewIdentity {
  initialUrl?: string | null;
  profileHost?: BrowserWebviewProfileHost;
}
interface ResidentBrowserInput extends BrowserWebviewIdentity {
  url: string;
  profileHost?: BrowserWebviewProfileHost;
}
const residentInputs = new Map<string, ResidentBrowserInput>();
interface PendingWebview {
  creation: Promise<HTMLElement | null>;
  /** The latest URL asked for while the partition is prepared; the new guest loads it. */
  url: string;
}
const pendingWebviews = new Map<string, PendingWebview>();
/**
 * Only one window serves a host's tunnel. Main tells the other windows when a provider
 * registers, so their failed routed tabs recover too, once per registration.
 */
const remoteProviders = new Map<string, { generation: number; ready: boolean }>();
const replacementListeners = new Map<string, Set<() => void>>();

export function subscribeBrowserWebviewReplacement(
  browserId: string,
  listener: () => void,
): () => void {
  let listeners = replacementListeners.get(browserId);
  if (!listeners) {
    listeners = new Set();
    replacementListeners.set(browserId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) replacementListeners.delete(browserId);
  };
}
function notifyReplacement(browserId: string) {
  for (const listener of replacementListeners.get(browserId) ?? []) listener();
}
function configureBrowserWebview(
  webview: HTMLElement,
  input: PrepareBrowserInput,
  browser: BrowserWebviewProfileHost,
  partition: string,
): void {
  webview.setAttribute(BROWSER_ID_ATTRIBUTE, input.browserId);
  webview.setAttribute("partition", partition);
  webview.setAttribute("allowpopups", "true");
  webview.setAttribute("spellcheck", "false");
  webview.setAttribute("autosize", "on");
  if (input.initialUrl) (webview as BrowserWebviewElement).src = input.initialUrl;
  registerBrowserWhenAttached(webview as BrowserWebviewElement, input, browser);
  observeHostNetworkFailures(webview, input.serverId);
}
export function ensureResidentBrowserWebview(
  input: ResidentBrowserInput,
): Promise<HTMLElement | null> {
  if (!input.profileHost) ensureBrowserRoutingListener();
  const pending = pendingWebviews.get(input.browserId);
  if (pending) {
    // A navigation submitted while the partition is prepared must not be lost.
    pending.url = input.url;
    return pending.creation;
  }
  const entry: PendingWebview = { creation: Promise.resolve(null), url: input.url };
  entry.creation = createResidentBrowserWebview(input, () => entry.url).finally(() => {
    if (pendingWebviews.get(input.browserId) === entry) pendingWebviews.delete(input.browserId);
  });
  pendingWebviews.set(input.browserId, entry);
  return entry.creation;
}
async function createResidentBrowserWebview(
  input: ResidentBrowserInput,
  latestUrl: () => string,
): Promise<HTMLElement | null> {
  const browserId = trimNonEmpty(input.browserId);
  const ownerDocument = readDocument();
  if (!browserId || !ownerDocument) return null;
  const browser = getBrowserBridge(input.profileHost);
  residentInputs.set(browserId, input);
  const partition = await (browser.resolvePartition ?? resolveBrowserPartition)(
    input.serverId,
    browser.profilePartition,
  );
  // Closing a tab or changing routing while preparation was pending cancels that attach.
  if (residentInputs.get(browserId) !== input) return null;
  const requestedUrl = latestUrl();
  const existing = getResidentBrowserWebview(browserId);
  if (existing?.getAttribute("partition") === partition) {
    if (
      residentWebviewsByBrowserId.has(browserId) ||
      existing.parentElement?.id === RESIDENT_BROWSER_HOST_ID
    )
      releaseResidentBrowserWebview(browserId, existing);
    if (requestedUrl !== input.url) (existing as BrowserWebviewElement).src = requestedUrl;
    return existing;
  }
  let url = requestedUrl;
  if (existing) {
    // A routing change keeps the page the old guest was on, unless a newer URL was asked for.
    url = requestedUrl === input.url ? readWebviewUrl(existing, url) : requestedUrl;
    retireBrowserWebview(existing);
    residentWebviewsByBrowserId.delete(browserId);
  }
  const webview = ownerDocument.createElement("webview") as BrowserWebviewElement;
  configureBrowserWebview(webview, { ...input, initialUrl: url }, browser, partition);
  releaseResidentBrowserWebview(browserId, webview);
  if (existing) notifyReplacement(browserId);
  return webview;
}
function readWebviewUrl(webview: HTMLElement, fallback: string): string {
  const guest = webview as BrowserWebviewElement & { getURL?: () => string };
  try {
    return guest.getURL?.() || guest.src || fallback;
  } catch {
    return guest.src || fallback;
  }
}

export async function recreateHostBrowserWebviews(
  serverId: string,
  enabled: boolean,
): Promise<void> {
  const replacements: Promise<unknown>[] = [];
  for (const [browserId, input] of residentInputs) {
    if (input.serverId !== serverId) continue;
    const webview = getResidentBrowserWebview(browserId);
    const isRouted = webview
      ?.getAttribute("partition")
      ?.startsWith(ROUTED_BROWSER_PARTITION_PREFIX);
    if (webview && isRouted === enabled) continue;
    const url = webview ? readWebviewUrl(webview, input.url) : input.url;
    // Stop the old network path immediately, before asynchronous proxy preparation.
    if (webview) retireBrowserWebview(webview);
    residentWebviewsByBrowserId.delete(browserId);
    pendingWebviews.delete(browserId);
    replacements.push(
      ensureResidentBrowserWebview({ ...input, url }).finally(() => notifyReplacement(browserId)),
    );
  }
  await Promise.all(replacements);
}
let routingListener: Promise<() => void> | null = null;
function ensureBrowserRoutingListener(): void {
  if (routingListener) return;
  // Resident tabs outlive their host connection, so these listeners follow the tabs.
  routingListener = Promise.all([
    routingDesktop.listen("browser_routing_changed", (raw) => {
      const event = routingChangedSchema.parse(raw);
      // A routing change or a provider handoff: no window is known to be serving yet.
      const remote = remoteProviders.get(event.serverId);
      if (remote) remote.ready = false;
      void recreateHostBrowserWebviews(event.serverId, event.enabled).catch((error) =>
        console.error("[browser-routing] webview preparation failed", error),
      );
    }),
    routingDesktop.listen("browser_routing_provider_ready", (raw) => {
      markRemoteProviderReady(providerReadySchema.parse(raw).serverId);
    }),
  ]).then((disposers) => () => {
    for (const dispose of disposers) dispose();
  });
  void routingListener.catch((error) =>
    console.error("[browser-routing] event listener failed", error),
  );
}
function stopBrowserRoutingListener(): void {
  const listener = routingListener;
  routingListener = null;
  void listener
    ?.then((dispose) => dispose())
    .catch((error) => console.error("[browser-routing] event listener cleanup failed", error));
}

export function getResidentBrowserWebview(browserId: string): HTMLElement | null {
  const normalizedBrowserId = trimNonEmpty(browserId);
  if (!normalizedBrowserId) {
    return null;
  }
  const resident = residentWebviewsByBrowserId.get(normalizedBrowserId) ?? null;
  if (resident?.isConnected) {
    return resident;
  }
  const ownerDocument = readDocument();
  return ownerDocument ? findBrowserWebview(normalizedBrowserId, ownerDocument) : null;
}

export function releaseResidentBrowserWebview(browserId: string, webview: HTMLElement): void {
  if (retiredWebviews.has(webview)) return;
  const normalizedBrowserId = trimNonEmpty(browserId);
  if (!normalizedBrowserId) {
    webview.remove();
    return;
  }
  const ownerDocument = readDocument();
  if (!ownerDocument) {
    return;
  }

  residentWebviewsByBrowserId.set(normalizedBrowserId, webview);
  applyResidentWebviewStyle(webview, normalizedBrowserId);
  const surface = getBrowserSurface(normalizedBrowserId, ownerDocument);
  applyParkedBrowserSurfaceStyle(surface);
  attachWebviewTo(surface, webview);
}

export function resizeResidentBrowserWebview(input: {
  browserId: string;
  width: number;
  height: number;
}): { width: number; height: number } | null {
  const normalizedBrowserId = trimNonEmpty(input.browserId);
  if (!normalizedBrowserId) {
    return null;
  }
  const dimensions = rememberBrowserWebviewSize(input);
  if (!dimensions) {
    return null;
  }

  const ownerDocument = readDocument();
  const webview = ownerDocument ? findBrowserWebview(normalizedBrowserId, ownerDocument) : null;
  if (webview) {
    applyBrowserWebviewDimensions(webview, dimensions);
  }

  return dimensions;
}

export function removeResidentBrowserWebview(browserId: string): void {
  const normalizedBrowserId = trimNonEmpty(browserId);
  if (!normalizedBrowserId) {
    return;
  }

  residentInputs.delete(normalizedBrowserId);
  if (residentInputs.size === 0) stopBrowserRoutingListener();
  pendingWebviews.delete(normalizedBrowserId);
  const resident = residentWebviewsByBrowserId.get(normalizedBrowserId) ?? null;
  const surface = residentSurfacesByBrowserId.get(normalizedBrowserId) ?? null;
  residentWebviewsByBrowserId.delete(normalizedBrowserId);
  residentSurfacesByBrowserId.delete(normalizedBrowserId);
  residentWebviewSizesByBrowserId.delete(normalizedBrowserId);
  if (resident) retireBrowserWebview(resident);
  surface?.remove();
}

export function clearResidentBrowserWebviewsForTests(): void {
  stopBrowserRoutingListener();
  residentInputs.clear();
  pendingWebviews.clear();
  remoteProviders.clear();
  replacementListeners.clear();
  for (const webview of residentWebviewsByBrowserId.values()) {
    webview.remove();
  }
  residentWebviewsByBrowserId.clear();
  residentSurfacesByBrowserId.clear();
  residentWebviewSizesByBrowserId.clear();
  readDocument()?.getElementById(RESIDENT_BROWSER_HOST_ID)?.remove();
}

interface FailedHostNavigation {
  failed: boolean;
  /** Last provider generation of this window's own status that reloaded the tab. */
  recoveredGeneration: number;
  /** Last generation of a provider served by another window that reloaded the tab. */
  recoveredRemoteGeneration: number;
}
const failedHostNavigations = new WeakMap<HTMLElement, FailedHostNavigation>();
function observeHostNetworkFailures(webview: HTMLElement, serverId: string): void {
  const navigation = { failed: false, recoveredGeneration: 0, recoveredRemoteGeneration: 0 };
  failedHostNavigations.set(webview, navigation);
  const signal = listenerSignal(webview);
  webview.addEventListener(
    "did-start-loading",
    () => {
      navigation.failed = false;
    },
    { signal },
  );
  webview.addEventListener(
    "did-fail-load",
    (event) => {
      const details = event as Event & { errorCode?: number; isMainFrame?: boolean };
      if (
        details.isMainFrame === false ||
        ![-130, -111, -324, -100].includes(details.errorCode ?? 0)
      )
        return;
      navigation.failed = true;
      retryFailedHostNavigation(webview, serverId, navigation);
    },
    { signal },
  );
  webview.addEventListener(
    "did-navigate",
    (event) => {
      const details = event as Event & { httpResponseCode?: number };
      navigation.failed = details.httpResponseCode === 503;
      if (navigation.failed) retryFailedHostNavigation(webview, serverId, navigation);
    },
    { signal },
  );
}
function retryFailedHostNavigation(
  webview: HTMLElement,
  serverId: string,
  navigation: FailedHostNavigation,
): void {
  const host = useNetworkRoutingStatus.getState().hosts[serverId];
  const remote = remoteProviders.get(serverId);
  const routed = webview.getAttribute("partition")?.startsWith(ROUTED_BROWSER_PARTITION_PREFIX);
  const ownReady = host?.status === "ready" && navigation.recoveredGeneration < host.generation;
  const remoteReady =
    remote?.ready === true && navigation.recoveredRemoteGeneration < remote.generation;
  if (!routed || !navigation.failed || (!ownReady && !remoteReady)) return;
  if (ownReady && host) navigation.recoveredGeneration = host.generation;
  if (remoteReady && remote) navigation.recoveredRemoteGeneration = remote.generation;
  // A 503/-111 can arrive after the registration callback. Defer until the load event finishes.
  queueMicrotask(() => {
    if (retiredWebviews.has(webview) || !webview.isConnected) return;
    const guest = webview as HTMLElement & { reload(): void };
    guest.reload();
  });
}
/** Another window registered the host's provider: reload this window's failed routed tabs. */
export function markRemoteProviderReady(serverId: string): void {
  const remote = remoteProviders.get(serverId) ?? { generation: 0, ready: false };
  remote.generation += 1;
  remote.ready = true;
  remoteProviders.set(serverId, remote);
  reloadFailedHostBrowserWebviews(serverId);
}
export function reloadFailedHostBrowserWebviews(serverId: string): void {
  for (const [browserId, input] of residentInputs) {
    if (input.serverId !== serverId) continue;
    const webview = getResidentBrowserWebview(browserId);
    if (!webview) continue;
    const navigation = failedHostNavigations.get(webview);
    if (navigation) retryFailedHostNavigation(webview, serverId, navigation);
  }
}
