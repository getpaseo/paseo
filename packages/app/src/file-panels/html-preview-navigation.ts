export type HtmlPreviewNavigationKind = "initialDocument" | "fragment" | "blocked";

const INITIAL_DOCUMENT_URLS = new Set(["about:blank", "about:srcdoc", ""]);

export function htmlPreviewNavigationKind(url: string): HtmlPreviewNavigationKind {
  if (INITIAL_DOCUMENT_URLS.has(url)) return "initialDocument";
  if (url.startsWith("about:blank#") || url.startsWith("about:srcdoc#")) return "fragment";
  return "blocked";
}
