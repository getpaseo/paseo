import {
  buildDaemonWebSocketUrl,
  buildRelayWebSocketUrl as buildSharedRelayWebSocketUrl,
  deriveLabelFromEndpoint,
  extractHostPortFromWebSocketUrl,
  normalizeHostPort,
  parseHostPort,
  type HostPortParts,
} from "@server/shared/daemon-endpoints";

export { decodeOfferFragmentPayload } from "@server/shared/connection-offer";

export type { HostPortParts };

export {
  buildDaemonWebSocketUrl,
  deriveLabelFromEndpoint,
  extractHostPortFromWebSocketUrl,
  normalizeHostPort,
  parseHostPort,
};

export function buildRelayWebSocketUrl(params: { endpoint: string; serverId: string }): string {
  return buildSharedRelayWebSocketUrl({ ...params, role: "client" });
}
