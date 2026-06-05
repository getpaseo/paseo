const PARKING_LOT_ID = "paseo-browser-webview-parking-lot";

const parkedWebviewsByBrowserId = new Map<string, HTMLElement>();

function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getParkingLot(): HTMLElement {
  const existing = document.getElementById(PARKING_LOT_ID);
  if (existing) {
    return existing;
  }

  const lot = document.createElement("div");
  lot.id = PARKING_LOT_ID;
  lot.setAttribute("aria-hidden", "true");
  lot.style.position = "fixed";
  lot.style.left = "-10000px";
  lot.style.top = "0";
  lot.style.width = "1px";
  lot.style.height = "1px";
  lot.style.overflow = "hidden";
  lot.style.opacity = "0";
  lot.style.pointerEvents = "none";
  document.body.appendChild(lot);
  return lot;
}

export function parkBrowserWebview(browserId: string, webview: HTMLElement): void {
  const normalizedBrowserId = trimNonEmpty(browserId);
  if (!normalizedBrowserId) {
    webview.remove();
    return;
  }

  parkedWebviewsByBrowserId.set(normalizedBrowserId, webview);
  getParkingLot().appendChild(webview);
}

export function takeParkedBrowserWebview(browserId: string): HTMLElement | null {
  const normalizedBrowserId = trimNonEmpty(browserId);
  if (!normalizedBrowserId) {
    return null;
  }

  const webview = parkedWebviewsByBrowserId.get(normalizedBrowserId) ?? null;
  if (!webview) {
    return null;
  }

  parkedWebviewsByBrowserId.delete(normalizedBrowserId);
  return webview;
}

export function clearParkedBrowserWebviewsForTests(): void {
  for (const webview of parkedWebviewsByBrowserId.values()) {
    webview.remove();
  }
  parkedWebviewsByBrowserId.clear();
  document.getElementById(PARKING_LOT_ID)?.remove();
}
