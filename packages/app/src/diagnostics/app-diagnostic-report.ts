import type { ServerInfoStatusPayload } from "@getpaseo/protocol/messages";
import type { HostRuntimeSnapshot } from "@/runtime/host-runtime";
import type { HostConnection, HostProfile } from "@/types/host-connection";

interface DiagnosticEntry {
  label: string;
  value: string;
}

export function formatDiagnosticSection(title: string, entries: DiagnosticEntry[]): string {
  return [title, ...entries.map((entry) => `  ${entry.label}: ${entry.value}`)].join("\n");
}

export function formatAppDiagnosticHeader(input: {
  appVersion: string | null;
  platform: string;
  isDesktopApp: boolean;
  hostCount: number;
}): string {
  return formatDiagnosticSection("Paseo app diagnostics", [
    { label: "Collected at", value: new Date().toISOString() },
    { label: "App version", value: input.appVersion ?? "unknown" },
    { label: "Platform", value: input.platform },
    { label: "Desktop app", value: String(input.isDesktopApp) },
    { label: "Saved hosts", value: String(input.hostCount) },
  ]);
}

export function formatHostRuntimeSection(input: {
  host: HostProfile;
  snapshot: HostRuntimeSnapshot | null;
}): string {
  const { host, snapshot } = input;
  const entries: DiagnosticEntry[] = [
    { label: "Server ID", value: host.serverId },
    { label: "Status", value: snapshot?.connectionStatus ?? "not started" },
    {
      label: "Active connection",
      value: snapshot?.activeConnection
        ? describeConnectionKind(snapshot.activeConnection.type)
        : "none",
    },
    { label: "Last online", value: snapshot?.lastOnlineAt ?? "never" },
    { label: "Last error", value: snapshot?.lastError ?? "none" },
    {
      label: "Agent directory",
      value: snapshot?.agentDirectoryStatus ?? "unknown",
    },
  ];

  const connectionRows = host.connections.map((connection, index) => {
    const probe = snapshot?.probeByConnectionId.get(connection.id) ?? null;
    const isActive = snapshot?.activeConnectionId === connection.id;
    return {
      label: `Connection ${index + 1}`,
      value: [
        describeConnectionKind(connection.type),
        isActive ? "active" : "inactive",
        probe ? `probe=${probe.status}` : "probe=unknown",
        probe?.status === "available" ? `latency=${Math.round(probe.latencyMs)}ms` : null,
      ]
        .filter(Boolean)
        .join(", "),
    };
  });

  return formatDiagnosticSection(`Host: ${host.label}`, [...entries, ...connectionRows]);
}

export function formatServerInfoSection(serverInfo: ServerInfoStatusPayload | null): string {
  if (!serverInfo) {
    return formatDiagnosticSection("Server info", [{ label: "Status", value: "not received" }]);
  }

  const features = serverInfo.features ? Object.keys(serverInfo.features).sort() : [];
  return formatDiagnosticSection("Server info", [
    { label: "Server ID", value: serverInfo.serverId },
    { label: "Hostname", value: serverInfo.hostname ?? "unknown" },
    { label: "Version", value: serverInfo.version ?? "unknown" },
    { label: "Features", value: features.length > 0 ? features.join(", ") : "none" },
  ]);
}

export function describeConnectionKind(type: HostConnection["type"] | string): string {
  switch (type) {
    case "directTcp":
      return "direct TCP";
    case "directSocket":
      return "local socket";
    case "directPipe":
      return "local pipe";
    case "relay":
      return "relay";
    default:
      return "unknown";
  }
}

export function redactAppDiagnosticReport(report: string, hosts: HostProfile[]): string {
  let redacted = report;
  for (const value of collectSensitiveHostValues(hosts)) {
    redacted = redacted.split(value).join("[redacted]");
  }
  return redacted
    .replace(/paseo:\/\/\S+/gi, "paseo://[redacted]")
    .replace(
      /([?&](?:password|token|secret|key|publicKey|daemonPublicKeyB64)=)[^&\s"']+/gi,
      "$1[redacted]",
    )
    .replace(
      /((?:password|token|secret|authorization|api[_-]?key|daemonPublicKeyB64|relayKey)\s*[:=]\s*)("[^"]+"|'[^']+'|[^\s,}]+)/gi,
      "$1[redacted]",
    );
}

function collectSensitiveHostValues(hosts: HostProfile[]): string[] {
  const values = new Set<string>();
  for (const host of hosts) {
    for (const connection of host.connections) {
      values.add(connection.id);
      if (connection.type === "directTcp") {
        values.add(connection.endpoint);
        if (connection.password) values.add(connection.password);
      } else if (connection.type === "relay") {
        values.add(connection.relayEndpoint);
        values.add(connection.daemonPublicKeyB64);
      } else if (connection.type === "directSocket" || connection.type === "directPipe") {
        values.add(connection.path);
      }
    }
  }
  return [...values].filter((value) => value.trim().length > 0);
}
