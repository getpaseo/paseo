import { ChevronRight } from "lucide-react-native";
import { useCallback, useMemo, type ReactNode } from "react";
import { Text, View, type AccessibilityState, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ExternalLinkLabel } from "@/components/ui/external-link";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { PressHighlight } from "@/components/ui/press-highlight";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { useSettingsRowLayout } from "./row-density";

const ThemedChevron = withUnistyles(ChevronRight);
const hoveredIconColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });

type HoverState = PressableStateCallbackType & { hovered?: boolean };

export interface SettingsRowHeaderProps {
  label: string;
  /** Shown beside the label, such as a badge. */
  labelAccessory?: ReactNode;
  /** A line under the label saying what the row leads to. */
  hint?: string;
  /** A short status shown before the chevron. */
  summary?: string;
  onPress: () => void;
  disabled?: boolean;
  /** Turns the chevron down, for a row whose children are revealed in place. */
  expanded?: boolean;
  /** The row leaves the app, such as to a docs page: the summary and an outward arrow are drawn as an external link in place of the chevron. */
  external?: boolean;
  accessibilityState?: AccessibilityState;
  /** Props React Native Web does not derive from `accessibilityState`, such as `aria-expanded`. */
  webAccessibilityProps?: Record<string, unknown> | null;
  testID?: string;
}

/**
 * The pressable line shared by settings rows that lead somewhere: a label, an optional summary and
 * a trailing chevron. A collapsible row turns the chevron down; a row that opens a sheet keeps it
 * pointing right.
 */
export function SettingsRowHeader({
  label,
  labelAccessory,
  hint,
  summary,
  onPress,
  disabled,
  expanded = false,
  external = false,
  accessibilityState,
  webAccessibilityProps,
  testID,
}: SettingsRowHeaderProps) {
  const layout = useSettingsRowLayout();
  const rowStyle = useCallback(
    ({ hovered, pressed }: HoverState) => [
      layout.row,
      !disabled && hovered && styles.hovered,
      !disabled && pressed && styles.pressed,
    ],
    [disabled, layout],
  );
  const chevronStyle = useMemo(
    () => [styles.chevron, expanded && styles.chevronExpanded],
    [expanded],
  );
  return (
    <PressHighlight
      {...webAccessibilityProps}
      accessibilityRole={external ? "link" : "button"}
      accessibilityLabel={summary ? `${label}, ${summary}` : label}
      accessibilityState={accessibilityState}
      disabled={disabled}
      onPress={onPress}
      style={rowStyle}
      highlightStyle={styles.pressed}
      testID={testID}
    >
      {({ hovered }: HoverState) => (
        <>
          <View style={settingsStyles.rowContent}>
            {labelAccessory ? (
              <View style={styles.labelRow}>
                <Text style={layout.title}>{label}</Text>
                {labelAccessory}
              </View>
            ) : (
              <Text style={layout.title}>{label}</Text>
            )}
            {hint ? <Text style={layout.hint}>{hint}</Text> : null}
          </View>
          {external ? (
            // Drawn the same as a section header's docs link, so the two read as one thing.
            <ExternalLinkLabel hovered={hovered}>{summary}</ExternalLinkLabel>
          ) : (
            <>
              {summary ? (
                <Text style={styles.summary} numberOfLines={1}>
                  {summary}
                </Text>
              ) : null}
              {disabled ? null : (
                <View style={chevronStyle}>
                  <ThemedChevron
                    size={ICON_SIZE.sm}
                    uniProps={hovered ? hoveredIconColorMapping : mutedIconColorMapping}
                  />
                </View>
              )}
            </>
          )}
        </>
      )}
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  labelRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  summary: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginRight: theme.spacing[2],
  },
  hovered: {
    backgroundColor: theme.colors.surface2,
  },
  pressed: {
    backgroundColor: theme.colors.surface3,
  },
  // Optical: the chevron's ink sits about 4px inside its box whether it points right or down; this
  // puts the ink on the card's trailing rail, where the switch and the reports' refresh buttons end.
  chevron: { marginRight: -theme.spacing[1] },
  chevronExpanded: {
    transform: [{ rotate: "90deg" }],
  },
}));
