export const BROWSER_NEW_TAB_REQUEST_EVENT = "paseo:event:browser-new-tab-request";

export interface BrowserNewTabRequestPayload {
  sourceBrowserId: string;
  url: string;
}

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

export function handleBrowserWindowOpenRequest(input: {
  url: string;
  sourceBrowserId: string | null;
  requestNewTab: (payload: BrowserNewTabRequestPayload) => void;
}): { action: "deny" } {
  if (!isAllowedBrowserWebviewUrl(input.url) || !input.sourceBrowserId) {
    return { action: "deny" };
  }

  input.requestNewTab({
    sourceBrowserId: input.sourceBrowserId,
    url: input.url,
  });
  return { action: "deny" };
}
