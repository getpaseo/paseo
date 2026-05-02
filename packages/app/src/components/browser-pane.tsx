import { Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useMemo } from "react";

interface BrowserPaneProps {
  browserId: string;
  serverId: string;
  workspaceId: string;
  cwd: string | null;
  isInteractive?: boolean;
}

export function BrowserPane({ browserId }: BrowserPaneProps) {
  const { theme } = useUnistyles();
  const titleStyle = useMemo(
    () => [styles.title, { color: theme.colors.foreground }],
    [theme.colors.foreground],
  );
  const subtitleStyle = useMemo(
    () => [styles.subtitle, { color: theme.colors.foregroundMuted }],
    [theme.colors.foregroundMuted],
  );

  return (
    <View style={styles.container}>
      <Text style={titleStyle}>Browser is desktop-only</Text>
      <Text style={subtitleStyle}>Browser session {browserId}</Text>
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: 16,
  },
  title: {
    fontSize: 16,
    fontWeight: "600",
  },
  subtitle: {
    fontSize: 12,
  },
}));
