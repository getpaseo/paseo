import { getDesktopHost } from "@/desktop/host";

const RESIDENT_BROWSER_HOST_ID = "paseo-browser-resident-webviews";
const BROWSER_ID_ATTRIBUTE = "data-paseo-browser-id";
const RESIDENT_VIEWPORT_WIDTH = 1280;
const RESIDENT_VIEWPORT_HEIGHT = 800;

const residentWebviewsByBrowserId = new Map<string, HTMLElement>();
const activeCapturePreparations = new Map<string, ActiveCapturePreparation>();

let captureBridgeInstallCount = 0;
let captureBridgeDisposer: (() => void) | null = null;
let nextCapturePreparationId = 0;

interface BrowserWebviewElement extends HTMLElement {
  src: string;
}

interface ActiveCapturePreparation {
  browserId: string;
  requestId?: string;
  preparesResidentHost: boolean;
  webview: HTMLElement;
}

function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readDocument(): Document | null {
  return typeof document === "undefined" ? null : document;
}

function applyResidentHostParkingStyle(host: HTMLElement): void {
  host.setAttribute("aria-hidden", "true");
  host.style.position = "fixed";
  host.style.left = "-20000px";
  host.style.top = "0";
  host.style.width = `${RESIDENT_VIEWPORT_WIDTH}px`;
  host.style.height = `${RESIDENT_VIEWPORT_HEIGHT}px`;
  host.style.overflow = "hidden";
  host.style.opacity = "0";
  host.style.pointerEvents = "none";
  host.style.zIndex = "";
  host.style.clipPath = "";
  host.style.visibility = "";
  host.style.transform = "";
}

function applyResidentHostCaptureStyle(host: HTMLElement): void {
  host.setAttribute("aria-hidden", "true");
  host.style.position = "fixed";
  host.style.left = "0";
  host.style.top = "0";
  host.style.width = "1px";
  host.style.height = "1px";
  host.style.overflow = "hidden";
  host.style.opacity = "1";
  host.style.pointerEvents = "none";
  host.style.zIndex = "1";
  host.style.clipPath = "";
  host.style.visibility = "";
  host.style.transform = "";
}

function getResidentBrowserHost(ownerDocument: Document): HTMLElement {
  const existing = ownerDocument.getElementById(RESIDENT_BROWSER_HOST_ID);
  if (existing) {
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

function applyResidentWebviewStyle(webview: HTMLElement): void {
  webview.style.display = "inline-flex";
  webview.style.flex = "0 0 auto";
  webview.style.width = `${RESIDENT_VIEWPORT_WIDTH}px`;
  webview.style.height = `${RESIDENT_VIEWPORT_HEIGHT}px`;
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

function residentWebviewChildren(host: HTMLElement): HTMLElement[] {
  const webviews: HTMLElement[] = [];
  for (const element of host.querySelectorAll(`[${BROWSER_ID_ATTRIBUTE}]`)) {
    if (element instanceof HTMLElement) {
      webviews.push(element);
    }
  }
  return webviews;
}

function raiseResidentWebviewForCapture(host: HTMLElement, target: HTMLElement): void {
  for (const webview of residentWebviewChildren(host)) {
    applyResidentWebviewStyle(webview);
  }
  applyResidentWebviewStyle(target);
  target.style.zIndex = "2";
}

function nextAnimationFrame(): Promise<void> {
  if (typeof requestAnimationFrame !== "function") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      resolve();
    });
  });
}

async function waitForCapturePaint(webview: HTMLElement): Promise<void> {
  await nextAnimationFrame();
  await nextAnimationFrame();
  webview.getBoundingClientRect();
}

function activeCaptureTokenFor(input: { token?: string; requestId?: string }): string | null {
  const token = trimNonEmpty(input.token);
  if (token && activeCapturePreparations.has(token)) {
    return token;
  }
  const requestId = trimNonEmpty(input.requestId);
  if (!requestId) {
    return null;
  }
  for (const [candidateToken, preparation] of activeCapturePreparations.entries()) {
    if (preparation.requestId === requestId) {
      return candidateToken;
    }
  }
  return null;
}

function latestActiveResidentHostPreparation(): ActiveCapturePreparation | null {
  let latest: ActiveCapturePreparation | null = null;
  for (const preparation of activeCapturePreparations.values()) {
    if (preparation.preparesResidentHost) {
      latest = preparation;
    }
  }
  return latest;
}

function syncResidentHostCaptureState(): void {
  const host = readDocument()?.getElementById(RESIDENT_BROWSER_HOST_ID);
  if (!(host instanceof HTMLElement)) {
    return;
  }

  const latest = latestActiveResidentHostPreparation();
  if (latest) {
    applyResidentHostCaptureStyle(host);
    raiseResidentWebviewForCapture(host, latest.webview);
    return;
  }

  applyResidentHostParkingStyle(host);
  for (const webview of residentWebviewChildren(host)) {
    applyResidentWebviewStyle(webview);
  }
}

function releaseCapturePreparationToken(token: string): void {
  const preparation = activeCapturePreparations.get(token);
  if (!preparation) {
    return;
  }
  activeCapturePreparations.delete(token);
  if (preparation.preparesResidentHost) {
    applyResidentWebviewStyle(preparation.webview);
    syncResidentHostCaptureState();
  }
}

function releaseCapturePreparationsForBrowser(browserId: string): void {
  for (const [token, preparation] of activeCapturePreparations.entries()) {
    if (preparation.browserId === browserId) {
      activeCapturePreparations.delete(token);
    }
  }
  syncResidentHostCaptureState();
}

function releaseAllCapturePreparations(): void {
  activeCapturePreparations.clear();
  syncResidentHostCaptureState();
}

export function prepareBrowserWebview(
  webview: HTMLElement,
  input: { browserId: string; initialUrl?: string | null },
): void {
  webview.setAttribute(BROWSER_ID_ATTRIBUTE, input.browserId);
  webview.setAttribute("partition", `persist:paseo-browser-${input.browserId}`);
  webview.setAttribute("allowpopups", "true");
  webview.setAttribute("spellcheck", "false");
  webview.setAttribute("autosize", "on");
  if (input.initialUrl) {
    (webview as BrowserWebviewElement).src = input.initialUrl;
  }
}

export function ensureResidentBrowserWebview(input: {
  browserId: string;
  url: string;
}): HTMLElement | null {
  const browserId = trimNonEmpty(input.browserId);
  if (!browserId) {
    return null;
  }
  const ownerDocument = readDocument();
  if (!ownerDocument) {
    return null;
  }

  const resident = residentWebviewsByBrowserId.get(browserId) ?? null;
  if (resident?.isConnected) {
    return resident;
  }

  const existing = findBrowserWebview(browserId, ownerDocument);
  if (existing) {
    return existing;
  }

  const webview = ownerDocument.createElement("webview") as BrowserWebviewElement;
  prepareBrowserWebview(webview, { browserId, initialUrl: input.url });
  releaseResidentBrowserWebview(browserId, webview);
  return webview;
}

export function takeResidentBrowserWebview(browserId: string): HTMLElement | null {
  const normalizedBrowserId = trimNonEmpty(browserId);
  if (!normalizedBrowserId) {
    return null;
  }

  const webview = residentWebviewsByBrowserId.get(normalizedBrowserId) ?? null;
  if (!webview) {
    return null;
  }

  residentWebviewsByBrowserId.delete(normalizedBrowserId);
  clearResidentWebviewParkingStyle(webview);
  return webview;
}

export function releaseResidentBrowserWebview(browserId: string, webview: HTMLElement): void {
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
  applyResidentWebviewStyle(webview);
  getResidentBrowserHost(ownerDocument).appendChild(webview);
}

export async function prepareResidentBrowserWebviewForPixelCapture(input: {
  browserId: string;
  requestId?: string;
}): Promise<{ token: string }> {
  const browserId = trimNonEmpty(input.browserId);
  if (!browserId) {
    throw new Error("Browser id is required for pixel capture preparation.");
  }
  const ownerDocument = readDocument();
  if (!ownerDocument) {
    throw new Error("Browser pixel capture preparation requires a document.");
  }

  const host = getResidentBrowserHost(ownerDocument);
  const webview = findBrowserWebview(browserId, ownerDocument);
  if (!webview) {
    throw new Error(`Browser webview ${browserId} is not mounted.`);
  }

  const token = `capture-${++nextCapturePreparationId}`;
  const preparesResidentHost = webview.parentElement === host;
  const requestId = trimNonEmpty(input.requestId);
  activeCapturePreparations.set(token, {
    browserId,
    ...(requestId ? { requestId } : {}),
    preparesResidentHost,
    webview,
  });
  try {
    if (preparesResidentHost) {
      applyResidentHostCaptureStyle(host);
      raiseResidentWebviewForCapture(host, webview);
    }
    await waitForCapturePaint(webview);
    if (!activeCapturePreparations.has(token)) {
      throw new Error("Browser pixel capture preparation was canceled.");
    }
    return { token };
  } catch (error) {
    releaseCapturePreparationToken(token);
    throw error;
  }
}

export async function restoreResidentBrowserWebviewAfterPixelCapture(input: {
  token: string;
}): Promise<void> {
  releaseCapturePreparationToken(input.token);
}

export async function cancelResidentBrowserWebviewPixelCapture(input: {
  requestId?: string;
  token?: string;
}): Promise<void> {
  const token = activeCaptureTokenFor(input);
  if (!token) {
    return;
  }
  releaseCapturePreparationToken(token);
}

export function installResidentBrowserCaptureBridge(): () => void {
  captureBridgeInstallCount += 1;
  if (!captureBridgeDisposer) {
    const browserBridge = getDesktopHost()?.browser;
    const disposePrepare = browserBridge?.onPrepareForPixelCapture?.(
      prepareResidentBrowserWebviewForPixelCapture,
    );
    const disposeRestore = browserBridge?.onRestorePixelCapture?.(
      restoreResidentBrowserWebviewAfterPixelCapture,
    );
    const disposeCancel = browserBridge?.onCancelPixelCapture?.(
      cancelResidentBrowserWebviewPixelCapture,
    );
    captureBridgeDisposer = () => {
      disposePrepare?.();
      disposeRestore?.();
      disposeCancel?.();
    };
  }

  return () => {
    captureBridgeInstallCount = Math.max(0, captureBridgeInstallCount - 1);
    if (captureBridgeInstallCount > 0) {
      return;
    }
    captureBridgeDisposer?.();
    captureBridgeDisposer = null;
    releaseAllCapturePreparations();
  };
}

export function removeResidentBrowserWebview(browserId: string): void {
  const normalizedBrowserId = trimNonEmpty(browserId);
  if (!normalizedBrowserId) {
    return;
  }

  const resident = residentWebviewsByBrowserId.get(normalizedBrowserId) ?? null;
  residentWebviewsByBrowserId.delete(normalizedBrowserId);
  releaseCapturePreparationsForBrowser(normalizedBrowserId);
  resident?.remove();
}

export function clearResidentBrowserWebviewsForTests(): void {
  for (const webview of residentWebviewsByBrowserId.values()) {
    webview.remove();
  }
  residentWebviewsByBrowserId.clear();
  releaseAllCapturePreparations();
  nextCapturePreparationId = 0;
  readDocument()?.getElementById(RESIDENT_BROWSER_HOST_ID)?.remove();
}
