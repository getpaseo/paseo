import { invokeDesktopCommand } from "@/desktop/tauri/invoke-desktop-command";
import { getTauri, isTauriEnvironment } from "@/utils/tauri";

export type ManagedRuntimeStatus = {
  runtimeId: string;
  runtimeVersion: string;
  bundledRuntimeRoot: string;
  installedRuntimeRoot: string;
  installed: boolean;
  managedHome: string;
  transportType: string;
  transportPath: string;
  diagnosticsRoot: string;
  stateFilePath: string;
};

export type ManagedDaemonStatus = {
  runtimeId: string;
  runtimeVersion: string;
  runtimeRoot: string;
  managedHome: string;
  transportType: string;
  transportPath: string;
  daemonPid: number | null;
  daemonRunning: boolean;
  daemonStatus: string;
  logPath: string;
  serverId: string | null;
  hostname: string | null;
  relayEnabled: boolean;
  tcpEnabled: boolean;
  tcpListen: string | null;
  cliShimPath: string | null;
};

export type ManagedDaemonLogs = {
  logPath: string;
  contents: string;
};

export type ManagedPairingOffer = {
  relayEnabled: boolean;
  url: string | null;
  qr: string | null;
};

export type CliShimResult = {
  status:
    | "installed"
    | "removed"
    | "elevationDenied"
    | "automaticInstallUnavailable"
    | "manualInstallRequired";
  installed: boolean;
  path: string | null;
  message: string;
  manualInstructions: CliManualInstructions | null;
};

export type CliManualInstructions = {
  title: string;
  detail: string;
  commands: string;
};

export type ManagedTcpSettings = {
  enabled: boolean;
  host: string;
  port: number;
};

export type LocalTransportTarget = {
  transportType: "socket" | "pipe";
  transportPath: string;
};

type LocalTransportEventPayload = {
  sessionId: string;
  kind: "open" | "message" | "close" | "error";
  text?: string | null;
  binaryBase64?: string | null;
  code?: number | null;
  reason?: string | null;
  error?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function toNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseManagedRuntimeStatus(raw: unknown): ManagedRuntimeStatus {
  if (!isRecord(raw)) {
    throw new Error("Unexpected managed runtime status response.");
  }
  return {
    runtimeId: toStringOrNull(raw.runtimeId) ?? "",
    runtimeVersion: toStringOrNull(raw.runtimeVersion) ?? "",
    bundledRuntimeRoot: toStringOrNull(raw.bundledRuntimeRoot) ?? "",
    installedRuntimeRoot: toStringOrNull(raw.installedRuntimeRoot) ?? "",
    installed: raw.installed === true,
    managedHome: toStringOrNull(raw.managedHome) ?? "",
    transportType: toStringOrNull(raw.transportType) ?? "socket",
    transportPath: toStringOrNull(raw.transportPath) ?? "",
    diagnosticsRoot: toStringOrNull(raw.diagnosticsRoot) ?? "",
    stateFilePath: toStringOrNull(raw.stateFilePath) ?? "",
  };
}

function parseManagedDaemonStatus(raw: unknown): ManagedDaemonStatus {
  if (!isRecord(raw)) {
    throw new Error("Unexpected managed daemon status response.");
  }
  return {
    runtimeId: toStringOrNull(raw.runtimeId) ?? "",
    runtimeVersion: toStringOrNull(raw.runtimeVersion) ?? "",
    runtimeRoot: toStringOrNull(raw.runtimeRoot) ?? "",
    managedHome: toStringOrNull(raw.managedHome) ?? "",
    transportType: toStringOrNull(raw.transportType) ?? "socket",
    transportPath: toStringOrNull(raw.transportPath) ?? "",
    daemonPid: toNumberOrNull(raw.daemonPid),
    daemonRunning: raw.daemonRunning === true,
    daemonStatus: toStringOrNull(raw.daemonStatus) ?? "unknown",
    logPath: toStringOrNull(raw.logPath) ?? "",
    serverId: toStringOrNull(raw.serverId),
    hostname: toStringOrNull(raw.hostname),
    relayEnabled: raw.relayEnabled === true,
    tcpEnabled: raw.tcpEnabled === true,
    tcpListen: toStringOrNull(raw.tcpListen),
    cliShimPath: toStringOrNull(raw.cliShimPath),
  };
}

function parseManagedDaemonLogs(raw: unknown): ManagedDaemonLogs {
  if (!isRecord(raw)) {
    throw new Error("Unexpected managed daemon logs response.");
  }
  return {
    logPath: toStringOrNull(raw.logPath) ?? "",
    contents: typeof raw.contents === "string" ? raw.contents : "",
  };
}

function parseManagedPairingOffer(raw: unknown): ManagedPairingOffer {
  if (!isRecord(raw)) {
    throw new Error("Unexpected managed daemon pairing response.");
  }
  return {
    relayEnabled: raw.relayEnabled === true,
    url: toStringOrNull(raw.url),
    qr: toStringOrNull(raw.qr),
  };
}

function parseCliManualInstructions(raw: unknown): CliManualInstructions | null {
  if (!isRecord(raw)) {
    return null;
  }
  return {
    title: toStringOrNull(raw.title) ?? "",
    detail: toStringOrNull(raw.detail) ?? "",
    commands: toStringOrNull(raw.commands) ?? "",
  };
}

export function parseCliShimResult(raw: unknown): CliShimResult {
  if (!isRecord(raw)) {
    throw new Error("Unexpected CLI shim response.");
  }
  return {
    status:
      (toStringOrNull(raw.status) as CliShimResult["status"] | null) ??
      (raw.installed === true ? "installed" : "removed"),
    installed: raw.installed === true,
    path: toStringOrNull(raw.path),
    message: toStringOrNull(raw.message) ?? "",
    manualInstructions: parseCliManualInstructions(raw.manualInstructions),
  };
}

export function shouldUseManagedDesktopDaemon(): boolean {
  return isTauriEnvironment() && getTauri() !== null;
}

export async function ensureManagedRuntime(): Promise<ManagedRuntimeStatus> {
  return parseManagedRuntimeStatus(await invokeDesktopCommand("ensure_managed_runtime"));
}

export async function getManagedRuntimeStatus(): Promise<ManagedRuntimeStatus> {
  return parseManagedRuntimeStatus(await invokeDesktopCommand("managed_runtime_status"));
}

export async function getManagedDaemonStatus(): Promise<ManagedDaemonStatus> {
  return parseManagedDaemonStatus(await invokeDesktopCommand("managed_daemon_status"));
}

export async function startManagedDaemon(): Promise<ManagedDaemonStatus> {
  return parseManagedDaemonStatus(await invokeDesktopCommand("start_managed_daemon"));
}

export async function stopManagedDaemon(): Promise<ManagedDaemonStatus> {
  return parseManagedDaemonStatus(await invokeDesktopCommand("stop_managed_daemon"));
}

export async function restartManagedDaemon(): Promise<ManagedDaemonStatus> {
  return parseManagedDaemonStatus(await invokeDesktopCommand("restart_managed_daemon"));
}

export async function getManagedDaemonLogs(): Promise<ManagedDaemonLogs> {
  return parseManagedDaemonLogs(await invokeDesktopCommand("managed_daemon_logs"));
}

export async function getManagedDaemonPairing(): Promise<ManagedPairingOffer> {
  return parseManagedPairingOffer(await invokeDesktopCommand("managed_daemon_pairing"));
}

export async function installManagedCliShim(): Promise<CliShimResult> {
  return parseCliShimResult(await invokeDesktopCommand("install_cli_shim"));
}

export async function uninstallManagedCliShim(): Promise<CliShimResult> {
  return parseCliShimResult(await invokeDesktopCommand("uninstall_cli_shim"));
}

export async function updateManagedDaemonTcpSettings(
  settings: ManagedTcpSettings
): Promise<ManagedDaemonStatus> {
  return parseManagedDaemonStatus(
    await invokeDesktopCommand("update_managed_daemon_tcp_settings", { settings })
  );
}

export type LocalTransportEventUnlisten = () => void;
export type LocalTransportEventHandler = (payload: LocalTransportEventPayload) => void;

export async function listenToLocalTransportEvents(
  handler: LocalTransportEventHandler
): Promise<LocalTransportEventUnlisten> {
  const listen = getTauri()?.event?.listen;
  if (typeof listen !== "function") {
    throw new Error("Tauri event API is unavailable.");
  }
  const unlisten = await listen("local-daemon-transport-event", (event: unknown) => {
    const payload = isRecord(event) && isRecord(event.payload) ? event.payload : null;
    if (!payload) {
      return;
    }
    handler({
      sessionId: toStringOrNull(payload.sessionId) ?? "",
      kind: (toStringOrNull(payload.kind) ?? "error") as LocalTransportEventPayload["kind"],
      text: toStringOrNull(payload.text),
      binaryBase64: toStringOrNull(payload.binaryBase64),
      code: toNumberOrNull(payload.code),
      reason: toStringOrNull(payload.reason),
      error: toStringOrNull(payload.error),
    });
  });
  return typeof unlisten === "function" ? unlisten : () => {};
}

export async function openLocalTransportSession(target: LocalTransportTarget): Promise<string> {
  const raw = await invokeDesktopCommand<unknown>("open_local_daemon_transport", target);
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error("Unexpected local transport session response.");
  }
  return raw;
}

export async function sendLocalTransportMessage(input: {
  sessionId: string;
  text?: string;
  binaryBase64?: string;
}): Promise<void> {
  await invokeDesktopCommand("send_local_daemon_transport_message", {
    sessionId: input.sessionId,
    ...(input.text ? { text: input.text } : {}),
    ...(input.binaryBase64 ? { binaryBase64: input.binaryBase64 } : {}),
  });
}

export async function closeLocalTransportSession(sessionId: string): Promise<void> {
  await invokeDesktopCommand("close_local_daemon_transport", { sessionId });
}
