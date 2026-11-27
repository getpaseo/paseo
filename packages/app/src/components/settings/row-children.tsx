import { Children, isValidElement, type ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { settingsStyles } from "@/styles/settings";
import { NestedSettingsRows } from "./row-density";

/**
 * Rows that belong to the row above them, such as the rows an expanded row reveals or the details
 * a switch turns on. They sit in the same card on a tinted band, laid out as nested rows.
 */
export function SettingsRowChildren({ children }: { children: ReactNode }) {
  return (
    <View style={styles.band}>
      <NestedSettingsRows>
        {Children.toArray(children).map((child, index) => (
          <View key={isValidElement(child) ? child.key : index} style={settingsStyles.rowBorder}>
            {child}
          </View>
        ))}
      </NestedSettingsRows>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // The rows keep the card's rails; the tint is what groups them under the row above.
  band: {
    backgroundColor: theme.colors.surface0,
  },
}));
