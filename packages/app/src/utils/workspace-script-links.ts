import { parseHostPort } from "@server/shared/daemon-endpoints";
import type { WorkspaceScriptPayload } from "@server/shared/messages";
import type { ActiveConnection } from "@/runtime/host-runtime";

export type ResolvedWorkspaceScriptLink = {
  openUrl: string | null;
  labelUrl: string | null;
};

function isLoopbackHost(host: string): boolean {
  const normalizedHost = host.trim().toLowerCase();
  return (
    normalizedHost === "localhost" || normalizedHost === "127.0.0.1" || normalizedHost === "::1"
  );
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

  if (activeConnection.type === "relay") {
    return { openUrl: null, labelUrl: script.proxyUrl };
  }

  if (activeConnection.type === "directSocket" || activeConnection.type === "directPipe") {
    return { openUrl: script.proxyUrl, labelUrl: script.proxyUrl };
  }

  try {
    const { host } = parseHostPort(activeConnection.endpoint);
    if (isLoopbackHost(host)) {
      return { openUrl: script.proxyUrl, labelUrl: script.proxyUrl };
    }
  } catch {
    return { openUrl: null, labelUrl: script.proxyUrl };
  }

  if (script.port === null) {
    return { openUrl: null, labelUrl: script.proxyUrl };
  }

  const directUrl = buildDirectServiceUrl(activeConnection.endpoint, script.port);
  return {
    openUrl: directUrl,
    labelUrl: directUrl ?? script.proxyUrl,
  };
}
