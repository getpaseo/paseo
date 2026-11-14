import { ChevronRight } from "lucide-react-native";
import { useCallback, useMemo, type ReactNode } from "react";
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

type HoverState = PressableStateCallbackType & { hovered?: boolean };

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
      accessibilityLabel={accessibilityLabel ?? (summary ? `${label}, ${summary}` : label)}
      accessibilityState={accessibilityState}
      disabled={disabled}
      onPress={onPress}
      style={rowStyle}
      highlightStyle={styles.pressed}
      testID={testID}
    >
      {({ hovered }: HoverState) => (
        <>
          {leading ? <View style={styles.leading}>{leading}</View> : null}
          <View style={settingsStyles.rowContent}>
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

/**
 * The hint with its status mark. The line keeps the hint's own height in every status, so a row
 * does not move when its value arrives or its work starts.
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
      <Text style={textStyle} numberOfLines={2}>
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
