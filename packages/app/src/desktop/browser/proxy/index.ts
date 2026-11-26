export {
  classifyHostBrowserRouting,
  extractBrowserProxyTarget,
  isLocalHostConnection,
  isLoopbackBrowserUrl,
  isLoopbackHost,
  shouldOpenUrlInProxiedWorkspaceBrowser,
  type ClassifyHostBrowserRoutingInput,
  type HostBrowserRouting,
} from "./internal/classify";
export {
  ensureHostBrowserProxy,
  installBrowserProxyRendererBridge,
  prepareHostBrowserPartition,
  readHostBrowserRouting,
  shouldRouteWorkspaceUrlToProxiedBrowser,
  type PrepareHostBrowserPartitionResult,
} from "./internal/bridge";
export { useHostBrowserProxy, type BrowserProxyPaneState } from "./internal/use-host-browser-proxy";
