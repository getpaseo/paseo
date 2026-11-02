import { serializeConnectionUriForStorage } from "@/utils/daemon-endpoints";

export interface DirectConnectionHostInput {
  host: string;
  port: string;
  useTls: boolean;
  password: string;
}

export interface DirectConnectionHostLabels {
  hostRequired: string;
  invalidPort: string;
}

export interface NormalizedDirectConnectionHost {
  host: string;
  /** Port typed into the host field, if any. Overrides the separate port field. */
  port: string | null;
  isIpv6: boolean;
}

const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
const BRACKETED_IPV6_PATTERN = /^\[([^\]]*)\](?::(\d*))?$/;
const HOST_WITH_PORT_PATTERN = /^([^:]+):(\d+)$/;

/**
 * Users often paste `host:port` or a full URL into the host field.
 * Reduce it to a bare host (plus an optional port) before building the URI.
 */
export function normalizeDirectConnectionHost(input: string): NormalizedDirectConnectionHost {
  let host = input.trim().replace(SCHEME_PATTERN, "");
  const suffixIndex = host.search(/[/?#]/);
  if (suffixIndex !== -1) {
    host = host.slice(0, suffixIndex);
  }

  const bracketed = BRACKETED_IPV6_PATTERN.exec(host);
  if (bracketed) {
    return { host: bracketed[1] ?? "", port: bracketed[2] || null, isIpv6: true };
  }

  const hostWithPort = HOST_WITH_PORT_PATTERN.exec(host);
  if (hostWithPort) {
    return { host: hostWithPort[1] ?? "", port: hostWithPort[2] ?? null, isIpv6: false };
  }

  return { host, port: null, isIpv6: host.split(":").length > 2 };
}

export function buildDirectConnectionUri(
  draft: DirectConnectionHostInput,
  labels: DirectConnectionHostLabels,
): string {
  const normalized = normalizeDirectConnectionHost(draft.host);
  const port = Number((normalized.port ?? draft.port).trim());
  if (!normalized.host) {
    throw new Error(labels.hostRequired);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(labels.invalidPort);
  }

  return serializeConnectionUriForStorage({
    host: normalized.host,
    port,
    isIpv6: normalized.isIpv6,
    useTls: draft.useTls,
    ...(draft.password ? { password: draft.password } : {}),
  });
}
