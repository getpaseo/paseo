import satisfies from "semver/functions/satisfies.js";
import type { ServerInfoStatusPayload } from "../messages.js";

// COMPAT(networkTunnelVersion): added in v0.18.0, remove the version check once daemon floor >= v0.18.0.
export const NETWORK_TUNNEL_MIN_DAEMON_VERSION = "0.18.0";

export function supportsNetworkTunnel(
  serverInfo: Pick<ServerInfoStatusPayload, "version" | "features"> | null,
): boolean {
  return (
    serverInfo?.features?.networkTunnel === true &&
    satisfies(serverInfo.version ?? "", `>=${NETWORK_TUNNEL_MIN_DAEMON_VERSION}`, {
      includePrerelease: true,
    })
  );
}

export {
  decodeNetworkTunnelFrame,
  encodeNetworkTunnelFrame,
  NETWORK_TUNNEL_DEFAULT_INITIAL_CONNECTION_WINDOW_BYTES,
  NETWORK_TUNNEL_DEFAULT_INITIAL_STREAM_WINDOW_BYTES,
  NETWORK_TUNNEL_HEADER_BYTES,
  NETWORK_TUNNEL_MAX_CONCURRENT_STREAMS,
  NETWORK_TUNNEL_MAX_DATA_PAYLOAD_BYTES,
  NETWORK_TUNNEL_PROTOCOL_VERSION,
  NetworkTunnelCloseReason,
  NetworkTunnelCodecError,
  NetworkTunnelFrameType,
  type DecodedNetworkTunnelFrame,
  type NetworkTunnelCodecErrorCode,
  type NetworkTunnelFrame,
} from "./internal/codec.js";
