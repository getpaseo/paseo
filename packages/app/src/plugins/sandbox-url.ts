/**
 * The plugin document itself. Anything else is a navigation we deny.
 *
 * `about:srcdoc` is the plugin frame inside the host document — deny it and the
 * plugin never renders on native at all. It carries no destination: the content
 * is the `srcdoc` attribute the host document already wrote, so allowing it
 * grants nothing a plugin did not already have.
 *
 * Lives apart from `sandbox.tsx` so it is reachable without the WebView module
 * graph — and so `./sandbox` can keep resolving to the per-platform variant.
 */
export function isPluginDocumentUrl(url: string): boolean {
  const normalized = url.trim().toLowerCase();
  return (
    normalized === "about:blank" || normalized === "about:srcdoc" || normalized.startsWith("data:")
  );
}
