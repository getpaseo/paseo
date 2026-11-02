import { useMemo, type ReactNode } from "react";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ExternalLink, type ExternalLinkProps } from "@/components/ui/external-link";
import { SettingsInfoTip } from "./settings-info-tip";
import { settingsStyles } from "@/styles/settings";

interface SettingsSectionProps {
  title: string;
  /**
   * What this section is for. Renders as an info tooltip on the header; a
   * paragraph between the header and the card is wrong (docs/design.md §7).
   */
  info?: ReactNode;
  /**
   * A page outside the app, such as the docs, shown at the header's end as "Label ↗". Its glyph
   * sits as far inside the card's edge as the title does on the other side.
   */
  link?: Pick<ExternalLinkProps, "href" | "label" | "accessibilityLabel" | "tooltip" | "testID">;
  /** An action at the header's end, such as Refresh or Add. A link to a page is `link`. */
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
 * iOS-style grouped settings block: muted label + children stacked with a
 * consistent gap. The single primitive used for every section across settings;
 * don't reach for ad-hoc `<Text>` headers or bare card margins.
 */
export function SettingsSection({
  title,
  info,
  link,
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
          <Text style={settingsStyles.sectionHeaderTitle}>{title}</Text>
          {info ? (
            <SettingsInfoTip
              title={title}
              info={info}
              testID={testID ? `${testID}-info` : undefined}
            />
          ) : null}
        </View>
        {link ? (
          <View style={styles.link}>
            <ExternalLink {...link} />
          </View>
        ) : null}
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
  // Mirrors the header's marginLeft, so the link's glyph and the title's sit on matching rails.
  link: {
    marginRight: theme.spacing[1],
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  content: {
    gap: theme.spacing[3],
  },
  flush: {
    marginBottom: 0,
  },
}));
