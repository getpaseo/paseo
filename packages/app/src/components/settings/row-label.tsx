import { useMemo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ExternalLink, type ExternalLinkProps } from "@/components/ui/external-link";
import { settingsStyles } from "@/styles/settings";
import { useSettingsRowLayout } from "./row-density";

export type SettingsRowLink = Pick<ExternalLinkProps, "href" | "label" | "accessibilityLabel">;

export interface SettingsRowLabelProps {
  label: string;
  /** Shown beside the label, such as a badge. */
  labelAccessory?: ReactNode;
  /** A string is drawn as the hint line; any other node is drawn as given. */
  hint?: ReactNode;
  /** A page outside the app that helps with this row, drawn under the hint as "Label ↗". */
  link?: SettingsRowLink;
  error?: string | null;
}

/**
 * The text column shared by settings rows with inline controls and collapsible content.
 */
export function SettingsRowLabel({
  label,
  labelAccessory,
  hint,
  link,
  error,
}: SettingsRowLabelProps) {
  const layout = useSettingsRowLayout();
  const accessoryTitleStyle = useMemo(() => [layout.title, styles.accessoryLabel], [layout]);
  return (
    <>
      {labelAccessory ? (
        <View style={styles.labelRow}>
          <Text style={accessoryTitleStyle}>{label}</Text>
          <View style={styles.accessory}>{labelAccessory}</View>
        </View>
      ) : (
        <Text style={layout.title}>{label}</Text>
      )}
      {typeof hint === "string" ? <Text style={layout.hint}>{hint}</Text> : hint}
      {link ? (
        <View style={styles.link}>
          <ExternalLink {...link} />
        </View>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={settingsStyles.rowError}>
          {error}
        </Text>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  labelRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  accessoryLabel: { flexShrink: 1, minWidth: 0 },
  // A badge is taller than the label's line. It hangs into the row's padding instead, so the label
  // and hint keep the distances of a row without one.
  accessory: { marginVertical: -theme.spacing[1] },
  link: { alignItems: "flex-start", marginTop: theme.spacing[1] },
}));
