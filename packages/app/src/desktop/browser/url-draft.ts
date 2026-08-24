import { normalizeBrowserUrl } from "@/desktop/browser/store/state";

export type BrowserUrlDraft = { status: "navigate"; url: string } | { status: "ignored" };

/**
 * What submitting the URL bar means. Whitespace is not a destination, and the
 * daemon only accepts absolute http(s) URLs, so a bare "google.com" gains its
 * scheme here rather than at the webview.
 */
export function resolveBrowserUrlDraft(draft: string | undefined): BrowserUrlDraft {
  const trimmed = draft?.trim();
  if (!trimmed) {
    return { status: "ignored" };
  }
  return { status: "navigate", url: normalizeBrowserUrl(trimmed) };
}
