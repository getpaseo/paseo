import type { ServerInfoStatusPayload } from "@getpaseo/protocol/messages";
import type { DaemonServerInfo } from "@/stores/session-store";

export function toDaemonServerInfo(serverInfo: ServerInfoStatusPayload): DaemonServerInfo {
  return {
    serverId: serverInfo.serverId,
    hostname: serverInfo.hostname ?? null,
    version: serverInfo.version ?? null,
    ...(serverInfo.desktopManaged !== undefined
      ? { desktopManaged: serverInfo.desktopManaged }
      : {}),
    ...(serverInfo.capabilities ? { capabilities: serverInfo.capabilities } : {}),
    ...(serverInfo.features ? { features: serverInfo.features } : {}),
    ...(serverInfo.urlOpeners ? { urlOpeners: serverInfo.urlOpeners } : {}),
  };
}
