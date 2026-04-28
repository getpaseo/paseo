import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Globe, Terminal } from "lucide-react-native";
import type { McpTransport } from "@/api/library";

/**
 * Small badge that lives on MCP cards. `stdio` uses the terminal glyph;
 * `http` and `sse` share the globe glyph since both are network transports
 * from the user's perspective.
 */
export function TransportBadge({ transport }: { transport: McpTransport }) {
  const isStdio = transport === "stdio";
  return (
    <View style={styles.badge}>
      {isStdio ? (
        <Terminal size={10} color="currentColor" />
      ) : (
        <Globe size={10} color="currentColor" />
      )}
      <Text style={styles.label}>{transport}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.surface2,
  },
  label: {
    fontSize: 10,
    fontWeight: "500" as const,
    color: theme.colors.foregroundMuted,
    textTransform: "lowercase" as const,
  },
}));
