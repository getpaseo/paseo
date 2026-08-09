import { Platform } from "react-native";
import { getIsElectron } from "@/constants/platform";
import { useHostFeature } from "@/runtime/host-features";

export interface WorkspaceBrowserAvailabilityInput {
  isElectron: boolean;
  isAndroid: boolean;
  hasTcpTunnel: boolean;
}

export function resolveWorkspaceBrowserAvailability(
  input: WorkspaceBrowserAvailabilityInput,
): boolean {
  if (input.isElectron) {
    return true;
  }
  return input.isAndroid && input.hasTcpTunnel;
}

export function useWorkspaceBrowserAvailability(serverId: string): boolean {
  // COMPAT(androidBrowserTcpTunnel): added in v0.1.110, remove after 2027-01-17
  // when the supported daemon floor guarantees server_info.features.tcpTunnel.
  const hasTcpTunnel = useHostFeature(serverId, "tcpTunnel");
  return resolveWorkspaceBrowserAvailability({
    isElectron: getIsElectron(),
    isAndroid: Platform.OS === "android",
    hasTcpTunnel,
  });
}
