/**
 * Decide whether a direct-TCP connection must open through the Electron
 * main-process Node `ws` bridge instead of the renderer browser WebSocket.
 *
 * Two layers force this choice and they point in opposite directions:
 *
 * - **macOS Local Network privacy** blocks the main process from reaching LAN
 *   hosts (`connect EHOSTUNREACH`); the renderer (Chromium) is not blocked. So
 *   the renderer WebSocket is the only transport that reaches a LAN daemon on
 *   macOS.
 * - **The renderer WebSocket always sends an `Origin` header** the browser
 *   controls, and the daemon rejects unlisted origins on the `/ws` upgrade
 *   (403, surfaced to the renderer as close code 1006). The Node bridge sends
 *   no `Origin`, so it always passes that check. It is also the only transport
 *   that can set the custom headers added in #2922.
 *
 * The packaged desktop renderer runs on `paseo://app`, which the daemon
 * allowlists (`packages/server/src/server/bootstrap.ts`), so headerless direct
 * connections work over the renderer. Custom headers can only travel over the
 * bridge, so header-bearing direct connections must use it and remain subject
 * to the macOS LAN limit.
 */
export function shouldRouteDirectTcpThroughHeaderBridge(input: {
  headers: Record<string, string> | undefined;
  hasWebSocketTransportFactory: boolean;
}): boolean {
  return (
    input.hasWebSocketTransportFactory &&
    input.headers !== undefined &&
    Object.keys(input.headers).length > 0
  );
}
