import type { DaemonTransportFactory } from "./daemon-client-transport-types.js";

/** Mirrors `PROTECTED_HANDSHAKE_FAILED_CLOSE_CODE` in `@getpaseo/relay/e2ee` without loading crypto deps. */
export const PROTECTED_HANDSHAKE_FAILED_CLOSE_CODE = 4002;

/**
 * Returns a user-facing message when this client closed the session itself
 * because endpoint security could not be established, so reconnecting cannot help.
 *
 * The daemon's own policy close never reaches the client: both relays replace a
 * daemon-side close with their own code (1012 on the wrangler relay).
 */
export function describeEndpointSecurityClose(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const code = "code" in event ? event.code : undefined;
  const reason = "reason" in event && typeof event.reason === "string" ? event.reason : "";
  if (code === PROTECTED_HANDSHAKE_FAILED_CLOSE_CODE) {
    return `Endpoint security handshake failed: ${reason || "protected mode unavailable"}`;
  }
  return null;
}

/**
 * Relay upgrades carry routing only. Daemon credentials and subprotocols must
 * never reach the relay; they travel inside the encrypted hello.
 */
export function createRelayUpgradeTransportFactory(
  baseFactory: DaemonTransportFactory,
): DaemonTransportFactory {
  return ({ url }) => baseFactory({ url });
}
