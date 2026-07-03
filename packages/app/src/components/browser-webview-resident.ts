const RESIDENT_BROWSER_HOST_ID = "paseo-browser-resident-webviews";
const BROWSER_ID_ATTRIBUTE = "data-paseo-browser-id";
const RESIDENT_VIEWPORT_WIDTH = 1280;
const RESIDENT_VIEWPORT_HEIGHT = 800;

const residentWebviewsByBrowserId = new Map<string, HTMLElement>();
const residentWebviewSizesByBrowserId = new Map<string, { width: number; height: number }>();

interface BrowserWebviewElement extends HTMLElement {
  src: string;
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
  // Parked browser webviews must remain paintable at all times; screenshot
  // correctness depends on the proven states in docs/browser-capture-harness.md.
  host.setAttribute("aria-hidden", "true");
  host.style.position = "fixed";
  host.style.left = "0";
  host.style.top = "0";
  host.style.width = "1px";
  host.style.height = "1px";
  host.style.overflow = "hidden";
  host.style.opacity = "1";
  host.style.pointerEvents = "none";
  host.style.display = "block";
  host.style.zIndex = "";
  host.style.clipPath = "";
  host.style.visibility = "visible";
  host.style.transform = "";
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
    releaseResidentBrowserWebview(browserId, resident);
    return resident;
  }

  const existing = findBrowserWebview(browserId, ownerDocument);
  if (existing) {
    if (existing.parentElement?.id === RESIDENT_BROWSER_HOST_ID) {
      releaseResidentBrowserWebview(browserId, existing);
    }
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
  applyResidentWebviewStyle(webview, normalizedBrowserId);
  getResidentBrowserHost(ownerDocument).appendChild(webview);
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
  const width = Math.max(1, Math.round(input.width));
  const height = Math.max(1, Math.round(input.height));
  residentWebviewSizesByBrowserId.set(normalizedBrowserId, { width, height });

  const ownerDocument = readDocument();
  const webview = ownerDocument ? findBrowserWebview(normalizedBrowserId, ownerDocument) : null;
  if (webview) {
    webview.style.width = `${width}px`;
    webview.style.height = `${height}px`;
  }

  return { width, height };
}

export function removeResidentBrowserWebview(browserId: string): void {
  const normalizedBrowserId = trimNonEmpty(browserId);
  if (!normalizedBrowserId) {
    return;
  }

  const resident = residentWebviewsByBrowserId.get(normalizedBrowserId) ?? null;
  residentWebviewsByBrowserId.delete(normalizedBrowserId);
  residentWebviewSizesByBrowserId.delete(normalizedBrowserId);
  resident?.remove();
}

export function clearResidentBrowserWebviewsForTests(): void {
  for (const webview of residentWebviewsByBrowserId.values()) {
    webview.remove();
  }
  residentWebviewsByBrowserId.clear();
  residentWebviewSizesByBrowserId.clear();
  readDocument()?.getElementById(RESIDENT_BROWSER_HOST_ID)?.remove();
}
