import type { ReactNode } from "react";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { settingsStyles } from "@/styles/settings";

interface SettingsSectionProps {
  title: string;
  trailing?: ReactNode;
  testID?: string;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}

/**
 * iOS-style grouped settings block: muted label + children stacked with a
 * consistent gap. The single primitive used for every section across settings;
 * don't reach for ad-hoc `<Text>` headers or bare card margins.
 */
export function SettingsSection({
  title,
  trailing,
  testID,
  style,
  children,
}: SettingsSectionProps) {
  return (
    <View style={[settingsStyles.section, style]} testID={testID}>
      <View style={styles.header}>
        <Text style={settingsStyles.sectionHeaderTitle}>{title}</Text>
        {trailing}
      </View>
      <View style={styles.content}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    marginBottom: theme.spacing[3],
    marginLeft: theme.spacing[1],
  },
  content: {
    gap: theme.spacing[3],
  },
}));
