import { ChevronRight } from "lucide-react-native";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Text, View, type AccessibilityState, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ControlSizeProvider } from "@/components/ui/control-size";
import { ExternalLinkLabel } from "@/components/ui/external-link";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SkeletonPulse, useSkeletonPulse } from "@/components/ui/skeleton";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { useSettingsRowLayout, type SettingsRowLayout } from "./row-density";

const ThemedChevron = withUnistyles(ChevronRight);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const hoveredIconColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });

/**
 * What the hint reports beyond its words: work under way (a leading spinner), a fault (a leading
 * red dot and red text), or a value still loading (a placeholder the height of the line).
 */
export type SettingsRowHintStatus = "busy" | "error" | "pending";

export interface SettingsRowHeaderProps {
  label: string;
  /** An icon before the label, such as the thing the row opens. */
  leading?: ReactNode;
  /** Shown beside the label, such as a badge. */
  labelAccessory?: ReactNode;
  /** A line under the label saying what the row leads to. */
  hint?: string;
  hintStatus?: SettingsRowHintStatus;
  /** A short status shown before the chevron. */
  summary?: string;
  onPress: () => void;
  disabled?: boolean;
  /** Turns the chevron down, for a row whose children are revealed in place. */
  expanded?: boolean;
  /** The row leaves the app, such as to a docs page: the summary and an outward arrow are drawn as an external link in place of the chevron. */
  external?: boolean;
  /** A control acting on the row's subject in place, such as a switch, before the chevron. */
  control?: ReactNode;
  /** Names the row for assistive tech when the label alone does not say where it leads. */
  accessibilityLabel?: string;
  accessibilityState?: AccessibilityState;
  /** Props React Native Web does not derive from `accessibilityState`, such as `aria-expanded`. */
  webAccessibilityProps?: Record<string, unknown> | null;
  testID?: string;
}

/**
 * The pressable line shared by settings rows that lead somewhere: a label, an optional summary and
 * a trailing chevron. A collapsible row turns the chevron down; a row that opens a sheet keeps it
 * pointing right.
 *
 * The press target is a button laid under the row's content rather than wrapped around it, so a
 * control in the row is the button's sibling: a switch inside a button is invalid markup, and keys
 * pressed on the switch would also press the row. Everything drawn over the button lets presses
 * through to it and stays out of the accessibility tree, where the button's label names the row.
 * Hover is tracked on the row itself, so it holds while the pointer is over the control.
 *
 * The row is as tall as one holding a control whether or not it holds one, so a list where only
 * some rows carry a switch keeps one row height.
 */
export function SettingsRowHeader({
  label,
  leading,
  labelAccessory,
  hint,
  hintStatus,
  summary,
  onPress,
  disabled,
  expanded = false,
  external = false,
  control,
  accessibilityLabel,
  accessibilityState,
  webAccessibilityProps,
  testID,
}: SettingsRowHeaderProps) {
  const layout = useSettingsRowLayout();
  const [pointerOver, setPointerOver] = useState(false);
  const handlePointerEnter = useCallback(() => setPointerOver(true), []);
  const handlePointerLeave = useCallback(() => setPointerOver(false), []);
  const hovered = pointerOver && !disabled;
  const rowStyle = useMemo(() => [layout.controlRow, hovered && styles.hovered], [hovered, layout]);
  const pressTargetStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.pressTarget,
      !disabled && pressed && styles.pressed,
    ],
    [disabled],
  );
  const chevronStyle = useMemo(
    () => [styles.chevron, expanded && styles.chevronExpanded],
    [expanded],
  );
  return (
    <View
      style={rowStyle}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      testID={testID}
    >
      <PressHighlight
        {...webAccessibilityProps}
        accessibilityRole={external ? "link" : "button"}
        accessibilityLabel={accessibilityLabel ?? (summary ? `${label}, ${summary}` : label)}
        accessibilityState={accessibilityState}
        disabled={disabled}
        onPress={onPress}
        style={pressTargetStyle}
        highlightStyle={styles.pressed}
      />
      {leading ? (
        <View style={[styles.leading, styles.passThrough]} {...HIDDEN_FROM_ASSISTIVE_TECH}>
          {leading}
        </View>
      ) : null}
      <View style={[settingsStyles.rowContent, styles.passThrough]} {...HIDDEN_FROM_ASSISTIVE_TECH}>
        {labelAccessory ? (
          <View style={styles.labelRow}>
            <Text style={layout.title}>{label}</Text>
            {labelAccessory}
          </View>
        ) : (
          <Text style={layout.title}>{label}</Text>
        )}
        {hintStatus ? (
          <RowHintLine hint={hint} status={hintStatus} hintStyle={layout.hint} />
        ) : null}
        {hint && !hintStatus ? <Text style={layout.hint}>{hint}</Text> : null}
      </View>
      {control ? (
        <View style={styles.control}>
          <ControlSizeProvider size={layout.controlSize}>{control}</ControlSizeProvider>
        </View>
      ) : null}
      <View style={[styles.trailing, styles.passThrough]} {...HIDDEN_FROM_ASSISTIVE_TECH}>
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
      </View>
    </View>
  );
}

const HIDDEN_FROM_ASSISTIVE_TECH = {
  accessibilityElementsHidden: true,
  importantForAccessibility: "no-hide-descendants",
  "aria-hidden": true,
} as const;

/**
 * The hint with its status mark. The line keeps the hint's own height in every status, so a row
 * does not move when its value arrives or its work starts. A long error is cut to the line; the
 * row's detail says it in full.
 */
function RowHintLine({
  hint,
  status,
  hintStyle,
}: {
  hint: string | undefined;
  status: SettingsRowHintStatus;
  hintStyle: SettingsRowLayout["hint"];
}) {
  const textStyle = useMemo(
    () => [hintStyle, styles.hintText, status === "error" && styles.hintError],
    [hintStyle, status],
  );
  if (status === "pending") {
    return (
      <View style={styles.hintLine}>
        {/* A blank line of hint text holds the height; the placeholder sits over it. */}
        <Text style={textStyle}> </Text>
        <HintPlaceholder />
      </View>
    );
  }
  return (
    <View style={styles.hintLine}>
      {status === "busy" ? (
        <ThemedLoadingSpinner size={14} uniProps={mutedIconColorMapping} />
      ) : (
        <View style={styles.errorDot} />
      )}
      <Text style={textStyle} numberOfLines={1}>
        {hint}
      </Text>
    </View>
  );
}

function HintPlaceholder() {
  const pulse = useSkeletonPulse();
  return <SkeletonPulse pulse={pulse} style={styles.hintPlaceholder} />;
}

const styles = StyleSheet.create((theme) => ({
  leading: {
    marginRight: theme.spacing[3],
    alignItems: "center",
    justifyContent: "center",
  },
  control: {
    marginRight: theme.spacing[3],
  },
  // The button under the row's content; it fills the row, padding included.
  pressTarget: {
    ...StyleSheet.absoluteFillObject,
  },
  passThrough: {
    pointerEvents: "none",
  },
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 1,
  },
  hintLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    marginTop: theme.spacing[1],
  },
  // The line carries the hint's top margin, so the mark and the words share one baseline box.
  hintText: {
    marginTop: 0,
    flexShrink: 1,
  },
  hintError: {
    color: theme.colors.statusDanger,
  },
  errorDot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.statusDanger,
  },
  hintPlaceholder: {
    position: "absolute",
    left: 0,
    top: theme.spacing[0.5],
    bottom: theme.spacing[0.5],
    width: theme.spacing[32],
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
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
