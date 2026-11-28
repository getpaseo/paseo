import type { HostConnection } from "@/types/host-connection";
import {
  buildDaemonWebSocketUrl,
  buildRelayWebSocketUrl,
  shouldUseTlsForDefaultHostedRelay,
} from "@/utils/daemon-endpoints";

export interface PairingCertificateApi {
  requiresCertificate(host: string, port: number): Promise<boolean>;
  choose(host: string, port: number): Promise<string | null>;
}

export function connectionCertificateTarget(connection: HostConnection) {
  let address: string;
  if (connection.type === "relay") {
    address = buildRelayWebSocketUrl({
      endpoint: connection.relayEndpoint,
      useTls: connection.useTls ?? shouldUseTlsForDefaultHostedRelay(connection.relayEndpoint),
      serverId: "certificate-probe",
    });
  } else if (connection.type === "directTcp") {
    address = buildDaemonWebSocketUrl(connection.endpoint, {
      useTls: connection.useTls ?? false,
    });
  } else {
    return null;
  }
  const url = new URL(address);
  if (url.protocol !== "wss:") return null;
  return { host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || 443) };
}

/** Run only after the user has confirmed a pairing target, before its first connection. */
export async function preparePairingCertificateWithApi(
  connection: HostConnection,
  certificates: PairingCertificateApi,
): Promise<boolean> {
  const target = connectionCertificateTarget(connection);
  if (!target || !(await certificates.requiresCertificate(target.host, target.port))) return true;
  return (await certificates.choose(target.host, target.port)) !== null;
}
