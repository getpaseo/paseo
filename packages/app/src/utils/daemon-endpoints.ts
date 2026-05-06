import {
  buildDaemonWebSocketUrl,
  buildRelayWebSocketUrl as buildSharedRelayWebSocketUrl,
  deriveLabelFromEndpoint,
  extractHostPortFromWebSocketUrl,
  normalizeHostPort,
  parseConnectionUri,
  parseHostPort,
  serializeConnectionUri,
  serializeConnectionUriForStorage,
  shouldUseTlsForDefaultHostedRelay,
  type HostPortParts,
} from "@server/shared/daemon-endpoints";

export { decodeOfferFragmentPayload } from "@server/shared/connection-offer";

export type { HostPortParts };

export {
  buildDaemonWebSocketUrl,
  deriveLabelFromEndpoint,
  extractHostPortFromWebSocketUrl,
  normalizeHostPort,
  parseConnectionUri,
  parseHostPort,
  serializeConnectionUri,
  serializeConnectionUriForStorage,
  shouldUseTlsForDefaultHostedRelay,
};

export function buildRelayWebSocketUrl(params: {
  endpoint: string;
  serverId: string;
  useTls: boolean;
}): string {
  return buildSharedRelayWebSocketUrl({ ...params, role: "client" });
}
