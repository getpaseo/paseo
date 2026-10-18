import { ChevronRight } from "lucide-react-native";
import { Children, isValidElement, useCallback, useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { isWeb } from "@/constants/platform";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { NestedSettingsRows, useSettingsRowLayout } from "./row-density";

const ThemedChevron = withUnistyles(ChevronRight);
const hoveredIconColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });

interface SettingsCollapsibleRowProps {
  label: string;
  /** A short status shown before the chevron, so the row says something while collapsed. */
  summary?: string;
  defaultExpanded?: boolean;
  testID?: string;
  /** The rows revealed underneath, separated like the rows of a `SettingsCard` and laid out as nested rows. */
  children: ReactNode;
}

/**
 * A settings row that folds a group of rows under it. Collapsed, it is one row: the label and a
 * trailing chevron that points right, and turns down once expanded. Sits inside a `SettingsCard` like any
 * other row.
 */
export function SettingsCollapsibleRow({
  label,
  summary,
  defaultExpanded = false,
  testID,
  children,
}: SettingsCollapsibleRowProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  // React Native Web does not map `accessibilityState.expanded` to `aria-expanded`.
  const webExpandedProps = useMemo(
    () => (isWeb ? ({ "aria-expanded": expanded } as const) : null),
    [expanded],
  );
  const layout = useSettingsRowLayout();
  const headerStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      layout.row,
      hovered && styles.headerHovered,
      pressed && styles.headerPressed,
    ],
    [layout],
  );
  const chevronStyle = useMemo(
    () => [styles.chevron, expanded && styles.chevronExpanded],
    [expanded],
  );

  return (
    <View testID={testID}>
      <Pressable
        {...webExpandedProps}
        accessibilityRole="button"
        accessibilityLabel={summary ? `${label}, ${summary}` : label}
        accessibilityState={accessibilityState}
        onPress={toggle}
        style={headerStyle}
        testID={testID ? `${testID}-toggle` : undefined}
      >
        {({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => (
          <>
            <View style={settingsStyles.rowContent}>
              <Text style={layout.title}>{label}</Text>
            </View>
            {summary ? <Text style={styles.summary}>{summary}</Text> : null}
            <View style={chevronStyle}>
              <ThemedChevron
                size={ICON_SIZE.sm}
                uniProps={hovered ? hoveredIconColorMapping : mutedIconColorMapping}
              />
            </View>
          </>
        )}
      </Pressable>
      {expanded ? (
        <View style={styles.children}>
          <NestedSettingsRows>
            {Children.toArray(children).map((child, index) => (
              <View
                key={isValidElement(child) ? child.key : index}
                style={settingsStyles.rowBorder}
              >
                {child}
              </View>
            ))}
          </NestedSettingsRows>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  summary: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginRight: theme.spacing[2],
  },
  // The revealed rows keep the card's rails; the tint is what groups them under their header.
  children: {
    backgroundColor: theme.colors.surface0,
  },
  headerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  headerPressed: {
    backgroundColor: theme.colors.surface3,
  },
  // Optical: the chevron's ink sits about 4px inside its box whether it points right or down; this
  // puts the ink on the card's trailing rail, where the switch and the reports' refresh buttons end.
  chevron: { marginRight: -theme.spacing[1] },
  chevronExpanded: {
    transform: [{ rotate: "90deg" }],
  },
}));
