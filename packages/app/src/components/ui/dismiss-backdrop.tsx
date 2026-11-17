import { Pressable, StyleSheet } from "react-native";

/** The invisible layer behind a dialog that closes it when pressed outside the dialog. */
export function DismissBackdrop({ label, onPress }: { label: string; onPress: () => void }) {
  return <Pressable accessibilityLabel={label} style={StyleSheet.absoluteFill} onPress={onPress} />;
}
