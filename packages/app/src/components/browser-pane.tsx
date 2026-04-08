import { Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

export function BrowserPane({ browserId }: { browserId: string }) {
  const { theme } = useUnistyles();

  return (
    <View style={styles.container}>
      <Text style={[styles.title, { color: theme.colors.foreground }]}>Browser is desktop-only</Text>
      <Text style={[styles.subtitle, { color: theme.colors.foregroundMuted }]}>Browser session {browserId}</Text>
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
