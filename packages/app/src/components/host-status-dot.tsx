import { useMemo } from "react";
import { View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  type HostRuntimeConnectionStatus,
  useHostRuntimeConnectionStatus,
} from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";

function hostStatusDotColor(status: HostRuntimeConnectionStatus, theme: Theme) {
  if (status === "online") return theme.colors.palette.green[400];
  if (status === "connecting") return theme.colors.palette.amber[500];
  return theme.colors.palette.red[500];
}

export function HostStatusDot({ serverId }: { serverId: string }) {
  const { theme } = useUnistyles();
  const status = useHostRuntimeConnectionStatus(serverId);
  const backgroundColor = hostStatusDotColor(status, theme);
  const dotStyle = useMemo(() => [styles.dot, { backgroundColor }], [backgroundColor]);

  return <View style={dotStyle} />;
}

const styles = StyleSheet.create(() => ({
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
}));
