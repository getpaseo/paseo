import { StyleSheet } from "react-native-unistyles";
import { useProviderIcon } from "@/components/provider-icons";
import { ICON_SIZE } from "@/styles/theme";

/** A provider's icon in the foreground colour, at row size unless the caller names another. */
export function ProviderGlyph({
  serverId,
  provider,
  size = ICON_SIZE.md,
}: {
  serverId: string;
  provider: string;
  size?: number;
}) {
  const Icon = useProviderIcon(provider, serverId);
  return <Icon size={size} color={styles.glyph.color} />;
}

const styles = StyleSheet.create((theme) => ({
  glyph: { color: theme.colors.foreground },
}));
