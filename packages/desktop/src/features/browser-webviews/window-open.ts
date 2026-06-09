export const BROWSER_NEW_TAB_REQUEST_EVENT = "paseo:event:browser-new-tab-request";

export interface BrowserNewTabRequestPayload {
  sourceBrowserId: string;
  url: string;
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
