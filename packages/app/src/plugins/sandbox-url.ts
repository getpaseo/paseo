/**
 * The plugin document itself. Anything else is a navigation we deny.
 *
 * Lives apart from `sandbox.tsx` so it is reachable without the WebView module
 * graph — and so `./sandbox` can keep resolving to the per-platform variant.
 */
export function isPluginDocumentUrl(url: string): boolean {
  const normalized = url.trim().toLowerCase();
  return normalized === "about:blank" || normalized.startsWith("data:");
}
