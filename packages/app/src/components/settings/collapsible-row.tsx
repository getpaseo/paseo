import { Children, isValidElement, useCallback, useMemo, useState, type ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import { settingsStyles } from "@/styles/settings";
import { NestedSettingsRows } from "./row-density";
import { SettingsRowHeader } from "./row-header";

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

  return (
    <View testID={testID}>
      <SettingsRowHeader
        label={label}
        summary={summary}
        onPress={toggle}
        expanded={expanded}
        accessibilityState={accessibilityState}
        webAccessibilityProps={webExpandedProps}
        testID={testID ? `${testID}-toggle` : undefined}
      />
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
  // The revealed rows keep the card's rails; the tint is what groups them under their header.
  children: {
    backgroundColor: theme.colors.surface0,
  },
}));
