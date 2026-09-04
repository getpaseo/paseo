import { parseHostPort } from "@getpaseo/protocol/daemon-endpoints";
import type {
  WorkspaceLaunchEndpointPayload,
  WorkspaceScriptPayload,
} from "@getpaseo/protocol/messages";
import type { ActiveConnection } from "@/runtime/host-runtime";

export type WorkspaceScriptLinkKind = "public" | "paseo" | "direct";

export interface WorkspaceScriptLinkTarget {
  kind: WorkspaceScriptLinkKind;
  label: string;
  url: string;
}

export interface ResolvedWorkspaceScriptLink {
  primary: WorkspaceScriptLinkTarget | null;
  targets: WorkspaceScriptLinkTarget[];
}

function isLoopbackHost(host: string): boolean {
  const normalizedHost = host.trim().toLowerCase();
  return (
    normalizedHost === "localhost" || normalizedHost === "127.0.0.1" || normalizedHost === "::1"
  );
}

function isLocalOnlyUrl(url: string | null | undefined): boolean {
  if (!url) return true;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return isLoopbackHost(hostname) || hostname.endsWith(".localhost");
  } catch {
    return true;
  }
}

function stripUrlProtocol(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

function buildDirectServiceUrl(
  activeConnection: ActiveConnection | null,
  port: number | null,
): string | null {
  if (port === null) return null;
  if (activeConnection?.type !== "directTcp") {
    return `http://localhost:${port}`;
  }
  try {
    const { host, isIpv6 } = parseHostPort(activeConnection.endpoint);
    let base = host;
    if (isLoopbackHost(host)) {
      base = "localhost";
    } else if (isIpv6) {
      base = `[${host}]`;
    }
    return `http://${base}:${port}`;
  } catch {
    return `http://localhost:${port}`;
  }
}

function isRemoteDirectTcpConnection(activeConnection: ActiveConnection | null): boolean {
  if (activeConnection?.type !== "directTcp") return false;
  try {
    return !isLoopbackHost(parseHostPort(activeConnection.endpoint).host);
  } catch {
    return false;
  }
}

function addTarget(
  targets: WorkspaceScriptLinkTarget[],
  kind: WorkspaceScriptLinkKind,
  url: string | null | undefined,
): void {
  if (!url || targets.some((target) => target.url === url)) return;
  targets.push({ kind, label: stripUrlProtocol(url), url });
}

function resolveServiceLinkTargets(input: {
  port: number | null;
  localProxyUrl?: string | null;
  publicProxyUrl?: string | null;
  proxyUrl?: string | null;
  activeConnection: ActiveConnection | null;
  includeLocalProxy?: boolean;
}): WorkspaceScriptLinkTarget[] {
  const {
    activeConnection,
    includeLocalProxy = true,
    localProxyUrl: explicitLocalProxyUrl,
    port,
    proxyUrl,
  } = input;
  // COMPAT(workspaceScriptSplitUrls): added in v0.2.0, remove after 2027-01-21.
  // Old daemons only send proxyUrl, so classify it by reachability.
  const localProxyUrl = explicitLocalProxyUrl ?? (isLocalOnlyUrl(proxyUrl) ? proxyUrl : null);
  const publicProxyUrl = input.publicProxyUrl ?? (!isLocalOnlyUrl(proxyUrl) ? proxyUrl : null);

  const targets: WorkspaceScriptLinkTarget[] = [];
  addTarget(targets, "public", publicProxyUrl);
  if (includeLocalProxy) addTarget(targets, "paseo", localProxyUrl);
  addTarget(targets, "direct", buildDirectServiceUrl(activeConnection, port));
  return targets;
}

export function resolveWorkspaceScriptLink(input: {
  script: WorkspaceScriptPayload;
  activeConnection: ActiveConnection | null;
}): ResolvedWorkspaceScriptLink {
  const { script, activeConnection } = input;
  if (script.type !== "service" || script.lifecycle !== "running") {
    return { primary: null, targets: [] };
  }

  const targets = resolveServiceLinkTargets({ ...script, activeConnection });

  return { primary: targets[0] ?? null, targets };
}

export function resolveWorkspaceLaunchEndpointLink(input: {
  endpoint: WorkspaceLaunchEndpointPayload;
  activeConnection: ActiveConnection | null;
}): ResolvedWorkspaceScriptLink {
  const { endpoint, activeConnection } = input;
  if (endpoint.protocol === "tcp") {
    return { primary: null, targets: [] };
  }

  const targets = resolveServiceLinkTargets({
    ...endpoint,
    activeConnection,
    // A .localhost proxy is resolved by the device, not the remote daemon. For a direct
    // connection to another host, offer only routes reachable from the client device.
    includeLocalProxy: !isRemoteDirectTcpConnection(activeConnection),
  });
  return { primary: targets[0] ?? null, targets };
}
