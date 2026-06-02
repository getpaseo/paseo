import { parseHostPort } from "@getpaseo/protocol/daemon-endpoints";
import type { WorkspaceScriptPayload } from "@getpaseo/protocol/messages";
import type { ActiveConnection } from "@/runtime/host-runtime";

export interface ResolvedWorkspaceScriptLink {
  openUrl: string | null;
  labelUrl: string | null;
}

function isLoopbackHost(host: string): boolean {
  const normalizedHost = host.trim().toLowerCase();
  return (
    normalizedHost === "localhost" || normalizedHost === "127.0.0.1" || normalizedHost === "::1"
  );
}

function isLocalOnlyUrl(url: string | null | undefined): boolean {
  if (!url) {
    return true;
  }
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    return isLoopbackHost(hostname) || hostname.endsWith(".localhost");
  } catch {
    return true;
  }
}

function buildDirectServiceUrl(endpoint: string, port: number): string | null {
  try {
    const { host, isIpv6 } = parseHostPort(endpoint);
    const base = isIpv6 ? `[${host}]` : host;
    return `http://${base}:${port}`;
  } catch {
    return null;
  }
}

export function resolveWorkspaceScriptLink(input: {
  script: WorkspaceScriptPayload;
  activeConnection: ActiveConnection | null;
}): ResolvedWorkspaceScriptLink {
  const { script, activeConnection } = input;
  if (script.type !== "service" || script.lifecycle !== "running") {
    return { openUrl: null, labelUrl: null };
  }

  if (!activeConnection) {
    return { openUrl: null, labelUrl: script.proxyUrl };
  }

  const localProxyUrl = script.localProxyUrl ?? script.proxyUrl;
  const publicProxyUrl =
    script.publicProxyUrl ?? (!isLocalOnlyUrl(script.proxyUrl) ? script.proxyUrl : null);
  const preferredProxyUrl = publicProxyUrl ?? localProxyUrl ?? script.proxyUrl;

  if (activeConnection.type === "relay") {
    return {
      openUrl: publicProxyUrl,
      labelUrl: publicProxyUrl ?? localProxyUrl ?? script.proxyUrl,
    };
  }

  if (activeConnection.type === "directSocket" || activeConnection.type === "directPipe") {
    return { openUrl: localProxyUrl, labelUrl: localProxyUrl };
  }

  try {
    const { host } = parseHostPort(activeConnection.endpoint);
    if (isLoopbackHost(host)) {
      return { openUrl: localProxyUrl, labelUrl: localProxyUrl };
    }
  } catch {
    return { openUrl: null, labelUrl: preferredProxyUrl };
  }

  if (publicProxyUrl) {
    return { openUrl: publicProxyUrl, labelUrl: publicProxyUrl };
  }

  if (script.port === null) {
    return { openUrl: null, labelUrl: script.proxyUrl };
  }

  const directUrl = buildDirectServiceUrl(activeConnection.endpoint, script.port);
  return {
    openUrl: directUrl,
    labelUrl: directUrl ?? preferredProxyUrl,
  };
}
