import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  type HostRuntimeConnectionStatus,
  useHostRuntimeConnectionStatus,
} from "@/runtime/host-runtime";

export function HostStatusDot({ serverId }: { serverId: string }) {
  const status = useHostRuntimeConnectionStatus(serverId);

  return <View style={[styles.dot, statusStyle(status)]} />;
}

function statusStyle(status: HostRuntimeConnectionStatus) {
  if (status === "online") return styles.dotOnline;
  if (status === "connecting") return styles.dotConnecting;
  return styles.dotOffline;
}

const styles = StyleSheet.create((theme) => ({
  dot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
  },
  dotOnline: {
    backgroundColor: theme.colors.statusSuccess,
  },
  dotConnecting: {
    backgroundColor: theme.colors.statusWarning,
  },
  dotOffline: {
    backgroundColor: theme.colors.statusDanger,
  },
}));
