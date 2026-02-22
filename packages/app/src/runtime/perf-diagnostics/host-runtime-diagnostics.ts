import type { DaemonClientDiagnosticsEvent } from "@server/client/daemon-client";
import { recordPerfDiagnosticMark } from "./engine";

let fastTransportSampleCursor = 0;
const transportRateByServer = new Map<
  string,
  {
    startedAtMs: number;
    messageCount: number;
    bytes: number;
    errorCount: number;
    slowCount: number;
  }
>();

function shouldSampleFastTransportEvent(): boolean {
  fastTransportSampleCursor += 1;
  if (fastTransportSampleCursor >= 50) {
    fastTransportSampleCursor = 0;
    return true;
  }
  return false;
}

export function recordHostRuntimeCreateClient(params: {
  serverId: string;
  connectionType: "direct" | "relay";
  endpoint: string;
}): void {
  recordPerfDiagnosticMark(
    "host_runtime.create_client",
    {
      serverId: params.serverId,
      connectionType: params.connectionType,
      endpoint: params.endpoint,
    },
    { force: true }
  );
}

export function recordDaemonClientDiagnostics(
  serverId: string,
  event: DaemonClientDiagnosticsEvent
): void {
  if (event.type === "transport_message_timing") {
    const nowWallTimeMs = Date.now();
    const current =
      transportRateByServer.get(serverId) ?? {
        startedAtMs: nowWallTimeMs,
        messageCount: 0,
        bytes: 0,
        errorCount: 0,
        slowCount: 0,
      };
    current.messageCount += 1;
    current.bytes += event.payloadBytes;
    if (event.outcome !== "ok") {
      current.errorCount += 1;
    }
    if (event.totalMs >= 8) {
      current.slowCount += 1;
    }
    if (nowWallTimeMs - current.startedAtMs >= 1000) {
      recordPerfDiagnosticMark(
        "daemon_client.message_rate",
        {
          serverId,
          windowMs: nowWallTimeMs - current.startedAtMs,
          messageCount: current.messageCount,
          bytes: current.bytes,
          errorCount: current.errorCount,
          slowCount: current.slowCount,
        },
        { force: current.errorCount > 0 || current.slowCount > 0 }
      );
      current.startedAtMs = nowWallTimeMs;
      current.messageCount = 0;
      current.bytes = 0;
      current.errorCount = 0;
      current.slowCount = 0;
    }
    transportRateByServer.set(serverId, current);
  }

  if (event.type === "transport_binary_frame") {
    if (event.payloadBytes < 16_384) {
      return;
    }
    recordPerfDiagnosticMark(
      "daemon_client.binary_frame",
      {
        serverId,
        channel: event.channel,
        messageType: event.messageType,
        payloadBytes: event.payloadBytes,
      },
      { force: true }
    );
    return;
  }

  const isSlow =
    event.totalMs >= 8 || event.parseMs >= 4 || event.validateMs >= 4;
  const isError = event.outcome !== "ok";
  if (!isSlow && !isError && !shouldSampleFastTransportEvent()) {
    return;
  }
  recordPerfDiagnosticMark(
    "daemon_client.transport_message",
    {
      serverId,
      messageType: event.messageType,
      outcome: event.outcome,
      payloadBytes: event.payloadBytes,
      parseMs: Math.round(event.parseMs * 100) / 100,
      validateMs: Math.round(event.validateMs * 100) / 100,
      totalMs: Math.round(event.totalMs * 100) / 100,
    },
    { force: isSlow || isError }
  );
}
