export const BROWSER_NEW_TAB_REQUEST_EVENT = "paseo:event:browser-new-tab-request";

export type BrowserWindowOpenDisposition =
  | "default"
  | "foreground-tab"
  | "background-tab"
  | "new-window"
  | "other";

export type BrowserWindowOpenDecision =
  | { kind: "deny" }
  | { kind: "popup" }
  | { kind: "workspace-tab"; url: string };

const MAX_PENDING_WINDOW_OPEN_REQUESTS_PER_GUEST = 20;

export class PendingBrowserWindowOpenRequests {
  private readonly urlsByWebContentsId = new Map<number, string[]>();

  public add(webContentsId: number, url: string): void {
    if (!isAllowedBrowserWebviewUrl(url)) {
      return;
    }
    const urls = this.urlsByWebContentsId.get(webContentsId) ?? [];
    if (urls.length >= MAX_PENDING_WINDOW_OPEN_REQUESTS_PER_GUEST) {
      return;
    }
    urls.push(url);
    this.urlsByWebContentsId.set(webContentsId, urls);
  }

  public take(webContentsId: number): string[] {
    const urls = this.urlsByWebContentsId.get(webContentsId) ?? [];
    this.urlsByWebContentsId.delete(webContentsId);
    return urls;
  }

  public delete(webContentsId: number): void {
    this.urlsByWebContentsId.delete(webContentsId);
  }
}

export function isAllowedBrowserWebviewUrl(value: string | undefined): boolean {
  if (!value) {
    return true;
  }
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.href === "about:blank"
    );
  } catch {
    return false;
  }
}

export function decideBrowserWindowOpenRequest(input: {
  url: string;
  disposition: BrowserWindowOpenDisposition;
  frameName: string;
  features: string;
  hasPostBody: boolean;
}): BrowserWindowOpenDecision {
  if (!isAllowedBrowserWebviewUrl(input.url)) {
    return { kind: "deny" };
  }

  const hasNamedWindowTarget = input.frameName.length > 0 && input.frameName !== "_blank";
  const isScriptPopup =
    input.disposition === "new-window" &&
    (input.features.trim().length > 0 || hasNamedWindowTarget);

  // A real popup preserves window.opener, postMessage, named-window reuse, and
  // window.close(). OAuth and payment flows depend on those browser contracts.
  // POST-backed opens must also remain real windows because a workspace tab can
  // only carry the URL and would silently turn the request into a GET.
  if (isScriptPopup || input.hasPostBody) {
    return { kind: "popup" };
  }

  return { kind: "workspace-tab", url: input.url };
}
