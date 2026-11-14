import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { settingsStyles } from "@/styles/settings";

/** A card holding one muted line, where a provider list or page has nothing to show yet. */
export function ProviderNotice({ message, testID }: { message: string; testID?: string }) {
  return (
    <View style={[settingsStyles.card, styles.card]} testID={testID}>
      <Text style={styles.text}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    padding: theme.spacing[4],
    alignItems: "center",
  },
  text: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));
