import { useMemo, type ReactNode } from "react";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SettingsInfoTip } from "./settings-info-tip";
import { settingsStyles } from "@/styles/settings";

interface SettingsSectionProps {
  title: string;
  /**
   * What this section is for. Renders as an info tooltip on the header; a
   * paragraph between the header and the card is wrong (docs/design.md §7).
   */
  info?: ReactNode;
  trailing?: ReactNode;
  testID?: string;
  style?: StyleProp<ViewStyle>;
  /**
   * Drops the section's bottom margin. Use when the section is the last child
   * of a SettingsGroup, so the group's own bottom margin owns the trailing gap.
   */
  flush?: boolean;
  children: ReactNode;
}

/**
 * Settings block: a titled run of hairline-ruled rows, stacked with a
 * consistent gap. The single primitive used for every section across settings;
 * don't reach for ad-hoc `<Text>` headers or bare card margins.
 */
export function SettingsSection({
  title,
  info,
  trailing,
  testID,
  style,
  flush,
  children,
}: SettingsSectionProps) {
  const sectionStyle = useMemo(
    () => [settingsStyles.section, flush ? styles.flush : null, style],
    [flush, style],
  );
  return (
    <View style={sectionStyle} testID={testID}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Text style={styles.title}>{title}</Text>
          {info ? (
            <SettingsInfoTip
              title={title}
              info={info}
              testID={testID ? `${testID}-info` : undefined}
            />
          ) : null}
        </View>
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
    paddingBottom: theme.spacing[3],
    paddingLeft: theme.spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  // Names the group of rows below it, so it carries the structural weight (docs/design.md §3).
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  content: {
    gap: theme.spacing[3],
  },
  flush: {
    marginBottom: 0,
  },
}));
