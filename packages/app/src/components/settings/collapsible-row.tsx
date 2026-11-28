import { useCallback, useMemo, useState, type ReactNode } from "react";
import { View } from "react-native";
import { isWeb } from "@/constants/platform";
import { SettingsRowChildren } from "./row-children";
import { SettingsRowHeader, type SettingsRowHintStatus } from "./row-header";

interface SettingsCollapsibleRowProps {
  label: string;
  /** A line under the label explaining the group. */
  hint?: string;
  hintStatus?: SettingsRowHintStatus;
  /** A short status shown before the chevron, so the row says something while collapsed. */
  summary?: string;
  /** A control acting on the row's subject in place, such as a switch, before the chevron. */
  control?: ReactNode;
  /** Names the expand/collapse button for assistive tech when the label alone is not enough. */
  accessibilityLabel?: string;
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
  hint,
  hintStatus,
  summary,
  control,
  accessibilityLabel,
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
        hint={hint}
        hintStatus={hintStatus}
        summary={summary}
        control={control}
        accessibilityLabel={accessibilityLabel}
        onPress={toggle}
        expanded={expanded}
        accessibilityState={accessibilityState}
        webAccessibilityProps={webExpandedProps}
        testID={testID ? `${testID}-toggle` : undefined}
      />
      {expanded ? <SettingsRowChildren>{children}</SettingsRowChildren> : null}
    </View>
  );
}
