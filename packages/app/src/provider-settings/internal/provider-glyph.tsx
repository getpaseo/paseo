import { StyleSheet } from "react-native-unistyles";
import { useProviderIcon } from "@/components/provider-icons";
import { ICON_SIZE } from "@/styles/theme";

/** A provider's icon at row size, drawn in the foreground colour. */
export function ProviderGlyph({ serverId, provider }: { serverId: string; provider: string }) {
  const Icon = useProviderIcon(provider, serverId);
  return <Icon size={ICON_SIZE.md} color={styles.glyph.color} />;
}

const styles = StyleSheet.create((theme) => ({
  glyph: { color: theme.colors.foreground },
}));
