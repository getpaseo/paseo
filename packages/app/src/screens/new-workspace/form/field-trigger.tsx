import { forwardRef, useCallback, type ReactElement, type ReactNode } from "react";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown } from "lucide-react-native";
import { ComboboxTrigger } from "@/components/ui/combobox-trigger";
import { CONTROL_HEIGHTS } from "@/components/ui/control-geometry";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ICON_SIZE, type Theme } from "@/styles/theme";

/**
 * `badge` is the desktop meta row: a borderless pill that names its field in a tooltip.
 * `field` is the compact form: a full-width filled box with the field's label inside, above the
 * value, so the whole field is one tap target.
 */
export type FieldTriggerVariant = "badge" | "field";

const ThemedChevronDown = withUnistyles(ChevronDown);
const extraMutedColor = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });

// Extra-muted: the chevron is an affordance, not information, and sits behind its label.
function Chevron(): ReactElement {
  return (
    <View style={styles.chevron}>
      <ThemedChevronDown size={ICON_SIZE.sm} uniProps={extraMutedColor} />
    </View>
  );
}

const chevron = <Chevron />;

export interface FieldTriggerContentProps {
  variant: FieldTriggerVariant;
  /** The field's name, shown inside a `field`. */
  label: string;
  icon: ReactNode;
  value: string;
  /** Secondary text after the value, such as a terminal profile's name. */
  detail?: string;
}

export function FieldTriggerContent({
  variant,
  label,
  icon,
  value,
  detail,
}: FieldTriggerContentProps): ReactElement {
  const valueLine = (
    <>
      <View style={styles.iconBox}>{icon}</View>
      <Text style={variant === "field" ? styles.fieldValue : styles.value} numberOfLines={1}>
        {value}
        {detail ? <Text style={styles.detail}> {detail}</Text> : null}
      </Text>
    </>
  );
  if (variant === "badge") {
    return (
      <>
        {valueLine}
        {chevron}
      </>
    );
  }
  return (
    <>
      <View style={styles.fieldBody}>
        <Text style={styles.fieldLabel} numberOfLines={1}>
          {label}
        </Text>
        <View style={styles.fieldValueLine}>{valueLine}</View>
      </View>
      {chevron}
    </>
  );
}

/** Pressable style for a field trigger, for triggers that bring their own Pressable. */
export function useFieldTriggerStyle(variant: FieldTriggerVariant, disabled: boolean) {
  return useCallback(
    (state: PressableStateCallbackType & { hovered?: boolean }) => [
      variant === "field" ? styles.field : styles.badge,
      !disabled && Boolean(state.hovered) && styles.highlighted,
      !disabled &&
        state.pressed &&
        (variant === "field" ? styles.highlighted : styles.badgePressed),
      disabled && styles.disabled,
    ],
    [disabled, variant],
  );
}

export interface FieldTriggerProps extends FieldTriggerContentProps {
  /** What a screen reader announces; defaults to `label`. */
  accessibilityLabel?: string;
  onPress: () => void;
  disabled?: boolean;
  /** Desktop hover hint; badges only, since a field shows its label. */
  tooltip?: string;
  testID?: string;
}

/** A field trigger that anchors a Combobox. */
export const FieldTrigger = forwardRef<View, FieldTriggerProps>(function FieldTrigger(
  { accessibilityLabel, onPress, disabled = false, tooltip, testID, ...content },
  ref,
): ReactElement {
  const style = useFieldTriggerStyle(content.variant, disabled);
  const trigger = (
    <ComboboxTrigger
      ref={ref}
      chevron={null}
      block={content.variant === "field"}
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      style={style}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? content.label}
    >
      <FieldTriggerContent {...content} />
    </ComboboxTrigger>
  );
  if (content.variant === "field" || !tooltip) return trigger;
  return (
    <Tooltip>
      <TooltipTrigger asChild triggerRefProp="ref">
        {trigger}
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{tooltip}</Text>
      </TooltipContent>
    </Tooltip>
  );
});

// Height of a badge. The desktop row sizes from it.
export const FIELD_BADGE_HEIGHT = CONTROL_HEIGHTS.tight;
// Height of a compact field: label line plus value line. The compact stack reserves rows from it.
export const FIELD_HEIGHT = 56;

const styles = StyleSheet.create((theme) => ({
  badge: {
    flexDirection: "row",
    alignItems: "center",
    height: FIELD_BADGE_HEIGHT,
    maxWidth: 240,
    overflow: "hidden",
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius["2xl"],
    gap: theme.spacing[1],
  },
  field: {
    flexDirection: "row",
    alignItems: "center",
    height: FIELD_HEIGHT,
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[3],
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface1,
    gap: theme.spacing[2],
  },
  highlighted: {
    backgroundColor: theme.colors.surface2,
  },
  badgePressed: {
    backgroundColor: theme.colors.surface0,
  },
  disabled: {
    opacity: 0.6,
  },
  // Optical: the chevron's ink sits high in its box.
  chevron: {
    flexShrink: 0,
    transform: [{ translateY: 1 }],
  },
  iconBox: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  value: {
    minWidth: 0,
    flexShrink: 1,
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  fieldBody: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[0.5],
  },
  fieldLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  fieldValueLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  fieldValue: {
    minWidth: 0,
    flexShrink: 1,
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  detail: {
    color: theme.colors.foregroundExtraMuted,
  },
  tooltipText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.popoverForeground,
  },
}));
