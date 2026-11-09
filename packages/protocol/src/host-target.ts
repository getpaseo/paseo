import { parseConnectionOfferFromUrl, type ConnectionOffer } from "./connection-offer.js";
import {
  buildDaemonWebSocketUrl,
  buildRelayWebSocketUrl,
  normalizeHostPort,
  parseConnectionUri,
  parseRelayConnectionUri,
  shouldUseTlsForDefaultHostedRelay,
} from "./daemon-endpoints.js";
import { parseSshTransportUri, type SshTransportTarget } from "./ssh-transport.js";

export type HostTarget =
  | { kind: "ssh"; ssh: SshTransportTarget; password?: string; description: string }
  | {
      kind: "socket";
      url: string;
      socketPath?: string;
      password?: string;
      offer?: ConnectionOffer;
      description: string;
    };

/** The shared saved-host and CLI grammar. Errors never echo credential-bearing input. */
export function parseHostTarget(input: string): HostTarget {
  try {
    return parse(input.trim());
  } catch {
    throw Object.assign(
      new Error(
        "Invalid host connection. Use host:port, ws(s)://, tcp://, unix://, pipe://, ssh:// or a pairing URL.",
      ),
      { code: "invalid_connection" },
    );
  }
}
function parse(input: string): HostTarget {
  if (!input) throw new Error("empty");
  if (input.startsWith("ssh://")) {
    return sshTarget(input);
  }

  if (input.startsWith("relay://") || input.includes("#connect=")) {
    const relay = parseRelayConnectionUri(input);
    return relayTarget(relay.offer, relay.password);
  }
  const offer = parseConnectionOfferFromUrl(input);
  if (offer) return relayTarget(offer);
  if (
    input.startsWith("unix://") ||
    input.startsWith("pipe://") ||
    input.startsWith("/") ||
    input.startsWith("~") ||
    input.startsWith("\\\\.\\pipe\\")
  ) {
    const socketPath = input.replace(/^(unix|pipe):\/\//, "");
    if (!socketPath || socketPath === "~") throw new Error("empty socket");
    const pipe = input.startsWith("pipe://") || input.startsWith("\\\\.\\pipe\\");
    return {
      kind: "socket",
      socketPath,
      url: pipe ? "ws://localhost/ws" : `ws+unix://${socketPath}:/ws`,
      description: `${pipe ? "pipe" : "unix"}://${socketPath}`,
    };
  }
  if (input.startsWith("tcp://")) return tcpTarget(input);
  if (/^wss?:\/\//.test(input)) return websocketTarget(input);
  const endpoint = validatedEndpoint(/^\d+$/.test(input) ? `127.0.0.1:${input}` : input);
  return {
    kind: "socket",
    url: buildDaemonWebSocketUrl(endpoint, { useTls: false }),
    description: `tcp://${endpoint}`,
  };
}
function relayTarget(offer: ConnectionOffer, password?: string): HostTarget {
  const endpoint = validatedEndpoint(offer.relay.endpoint);
  return {
    kind: "socket",
    url: buildRelayWebSocketUrl({
      endpoint,
      serverId: offer.serverId,
      role: "client",
      useTls: offer.relay.useTls ?? shouldUseTlsForDefaultHostedRelay(offer.relay.endpoint),
    }),
    offer,
    password,
    description: `relay://${endpoint}/${encodeURIComponent(offer.serverId)}`,
  };
}

function tcpTarget(input: string): HostTarget {
  const uri = new URL(input);
  if (uri.pathname && uri.pathname !== "/") throw new Error("Unexpected TCP path");
  if (uri.hash) throw new Error("Unexpected TCP fragment");
  const parts = parseConnectionUri(input);
  const endpoint = validatedEndpoint(
    `${parts.isIpv6 ? `[${parts.host}]` : parts.host}:${parts.port}`,
  );
  return {
    kind: "socket",
    url: buildDaemonWebSocketUrl(endpoint, { useTls: parts.useTls }),
    password: parts.password,
    description: `tcp://${endpoint}`,
  };
}
function websocketTarget(input: string): HostTarget {
  const url = new URL(input);
  if (!url.hostname || url.username || url.password || url.hash) throw new Error("invalid url");
  const password = url.searchParams.get("password") ?? undefined;
  // Unknown query parameters may themselves contain credentials; discovery shows only the origin.
  if (url.pathname === "/") url.pathname = "/ws";
  url.searchParams.delete("password");
  return { kind: "socket", url: url.toString(), password, description: url.origin };
}

function sshTarget(input: string): HostTarget {
  const uri = new URL(input);
  if (uri.searchParams.getAll("password").length > 1) throw new Error("Duplicate daemon password");
  const password = uri.searchParams.get("password") || undefined;
  uri.searchParams.delete("password");
  const ssh = parseSshTransportUri(uri.toString());
  return {
    kind: "ssh",
    ssh,
    ...(password ? { password } : {}),
    description: `ssh://${uri.hostname}${ssh.sshPort ? `:${ssh.sshPort}` : ""} (daemon port ${ssh.daemonPort})`,
  };
}

/** A bare endpoint has exactly one authority; URL syntax must use an explicit supported scheme. */
function validatedEndpoint(input: string): string {
  if (!/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\[[0-9a-fA-F:.]+\]):[0-9]{1,5}$/.test(input))
    throw new Error("Invalid endpoint");
  // URL parsing validates IPv6 literals and rejects invalid authority/port encodings.
  const url = new URL(`http://${input}`);
  if (!url.hostname) throw new Error("Missing endpoint host");
  return normalizeHostPort(input);
}
