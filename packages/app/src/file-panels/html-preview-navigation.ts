import { useCallback, useEffect, useRef } from "react";
import { useRetainedPanelActive } from "@/components/retained-panel";

export type HtmlPreviewNavigationKind = "initialDocument" | "fragment" | "blocked";

const INITIAL_DOCUMENT_URLS = new Set(["about:blank", "about:srcdoc", ""]);

export function htmlPreviewNavigationKind(url: string): HtmlPreviewNavigationKind {
  if (INITIAL_DOCUMENT_URLS.has(url)) return "initialDocument";
  if (url.startsWith("about:blank#") || url.startsWith("about:srcdoc#")) return "fragment";
  return "blocked";
}

/**
 * Decides each navigation the native WebView asks about: the document loads once, a fragment
 * moves within it, and anything else is refused.
 */
export function useHtmlPreviewNavigationGuard(
  document: string,
): (request: { url: string }) => boolean {
  // Latched per document rather than once for the lifetime of the WebView: the
  // file pane re-renders with new content on every live-file refresh, and each of
  // those is a fresh initial load that has to be allowed through.
  const loadedDocumentRef = useRef<string | null>(null);
  // The latch belongs to one native WebView, not to this component. iOS destroys the WebView of a
  // hidden retained panel and makes a new one when the panel shows, and that one loads the
  // document again. Releasing the latch while hidden lets that load through; a page on a kept
  // WebView gains at most a load of an inert initial URL.
  const active = useRetainedPanelActive();
  useEffect(() => {
    if (!active) loadedDocumentRef.current = null;
  }, [active]);
  return useCallback(
    ({ url }: { url: string }) => {
      const navigationKind = htmlPreviewNavigationKind(url);
      if (navigationKind === "fragment") return true;
      if (navigationKind === "blocked") return false;
      if (loadedDocumentRef.current === document) return false;
      loadedDocumentRef.current = document;
      return true;
    },
    [document],
  );
}
