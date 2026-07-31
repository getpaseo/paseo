import type { HostRuntimeConnectionStatus } from "@/runtime/host-runtime";

export interface LiveVoiceHostAvailability {
  serverId: string;
  label: string;
  connectionStatus: HostRuntimeConnectionStatus;
  version: string | null;
  supportsLiveVoice: boolean | null;
}

export type LiveVoiceUnavailableReason =
  | "platform_unsupported"
  | "no_hosts"
  | "hosts_connecting"
  | "hosts_offline"
  | "host_upgrade_required";

export type LiveVoiceAvailability =
  | {
      kind: "available";
      hosts: LiveVoiceHostAvailability[];
    }
  | {
      kind: "unavailable";
      reason: LiveVoiceUnavailableReason;
      hosts: LiveVoiceHostAvailability[];
    };

export function resolveLiveVoiceAvailability(input: {
  isPlatformSupported: boolean;
  hosts: LiveVoiceHostAvailability[];
}): LiveVoiceAvailability {
  const { isPlatformSupported, hosts } = input;
  if (!isPlatformSupported) {
    return { kind: "unavailable", reason: "platform_unsupported", hosts };
  }
  if (hosts.length === 0) {
    return { kind: "unavailable", reason: "no_hosts", hosts };
  }

  const availableHosts = hosts.filter(
    (host) => host.connectionStatus === "online" && host.supportsLiveVoice === true,
  );
  if (availableHosts.length > 0) {
    return { kind: "available", hosts: availableHosts };
  }

  const onlineHosts = hosts.filter((host) => host.connectionStatus === "online");
  const needsUpgrade = onlineHosts.some((host) => host.supportsLiveVoice === false);
  if (needsUpgrade) {
    return { kind: "unavailable", reason: "host_upgrade_required", hosts };
  }

  const isConnecting = hosts.some(
    (host) =>
      host.connectionStatus === "connecting" ||
      (host.connectionStatus === "online" && host.supportsLiveVoice === null),
  );
  if (isConnecting) {
    return { kind: "unavailable", reason: "hosts_connecting", hosts };
  }

  return { kind: "unavailable", reason: "hosts_offline", hosts };
}
