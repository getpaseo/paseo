const RESIDENT_BROWSER_HOST_ID = "paseo-browser-resident-webviews";
const BROWSER_ID_ATTRIBUTE = "data-paseo-browser-id";
const RESIDENT_VIEWPORT_WIDTH = 1280;
const RESIDENT_VIEWPORT_HEIGHT = 800;

const residentWebviewsByBrowserId = new Map<string, HTMLElement>();

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

function getResidentBrowserHost(ownerDocument: Document): HTMLElement {
  const existing = ownerDocument.getElementById(RESIDENT_BROWSER_HOST_ID);
  if (existing) {
    return existing;
  }

  const host = ownerDocument.createElement("div");
  host.id = RESIDENT_BROWSER_HOST_ID;
  host.setAttribute("aria-hidden", "true");
  host.style.position = "fixed";
  host.style.left = "-20000px";
  host.style.top = "0";
  host.style.width = `${RESIDENT_VIEWPORT_WIDTH}px`;
  host.style.height = `${RESIDENT_VIEWPORT_HEIGHT}px`;
  host.style.overflow = "hidden";
  host.style.opacity = "0";
  host.style.pointerEvents = "none";
  ownerDocument.body.appendChild(host);
  return host;
}

function findBrowserWebview(browserId: string, ownerDocument: Document): HTMLElement | null {
  for (const element of ownerDocument.querySelectorAll(`[${BROWSER_ID_ATTRIBUTE}]`)) {
    if (element.getAttribute(BROWSER_ID_ATTRIBUTE) === browserId) {
      return element as HTMLElement;
    }
  }
  return null;
}

function applyResidentWebviewStyle(webview: HTMLElement): void {
  webview.style.display = "block";
  webview.style.width = `${RESIDENT_VIEWPORT_WIDTH}px`;
  webview.style.height = `${RESIDENT_VIEWPORT_HEIGHT}px`;
  webview.style.border = "0";
  webview.style.background = "transparent";
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

export function removeResidentBrowserWebview(browserId: string): void {
  const normalizedBrowserId = trimNonEmpty(browserId);
  if (!normalizedBrowserId) {
    return;
  }

  const resident = residentWebviewsByBrowserId.get(normalizedBrowserId) ?? null;
  residentWebviewsByBrowserId.delete(normalizedBrowserId);
  resident?.remove();
}

export function clearResidentBrowserWebviewsForTests(): void {
  for (const webview of residentWebviewsByBrowserId.values()) {
    webview.remove();
  }
  residentWebviewsByBrowserId.clear();
  readDocument()?.getElementById(RESIDENT_BROWSER_HOST_ID)?.remove();
}
