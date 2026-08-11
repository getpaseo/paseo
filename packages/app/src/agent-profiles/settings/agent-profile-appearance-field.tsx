import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { Pressable, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check, ChevronDown } from "lucide-react-native";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import {
  createControlGeometry,
  resolveControlInteractionStyles,
  type FieldControlSize,
} from "@/components/ui/control-geometry";
import { Field } from "@/components/ui/form-field";
import { identityForeground } from "@/styles/identity-colors";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { AgentProfileGlyph } from "../internal/agent-profile-glyph";
import {
  AGENT_PROFILE_COLORS,
  AGENT_PROFILE_ICON_KEYS,
  resolveAgentProfileColor,
  resolveAgentProfileIconKey,
  type AgentProfileColor,
  type AgentProfileIconKey,
} from "../internal/profile-appearance";

const CELL_SIZE = 40;
const CELL_GAP = 4;
const GRID_COLUMNS = 5;
const CELL_ROW_WIDTH = GRID_COLUMNS * CELL_SIZE + (GRID_COLUMNS - 1) * CELL_GAP;
/** Matches `styles.body.padding`; both derive from `theme.spacing[3]`. */
const CELL_GRID_PADDING = 12;
/** Swatches are dots, not targets the eye has to land on precisely, so they pack tighter. */
const COLOR_CELL_SIZE = 32;
const SWATCH_SIZE = 20;

const EMPTY_COMBOBOX_OPTIONS: ComboboxOption[] = [];
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedCheck = withUnistyles(Check);

const foregroundMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const onIdentityMapping = (theme: Theme) => ({ color: theme.colors.background });

/**
 * Locked, not a floor: an unlocked popover stretches to its 400px maximum and
 * the wrapping grid follows it to eight columns. Two spare pixels so a frame
 * border can never push the fifth cell onto its own row.
 */
const DESKTOP_WIDTH = CELL_ROW_WIDTH + CELL_GRID_PADDING * 2 + 2;

/** Colours are named in host appearance; profiles reuse both the palette and its labels. */
function colorLabel(t: TFunction, color: AgentProfileColor): string {
  return t(`settings.host.appearance.color.options.${color}`);
}

function IconCell({
  iconKey,
  selected,
  color,
  onSelect,
}: {
  iconKey: AgentProfileIconKey | null;
  selected: boolean;
  color: AgentProfileColor;
  onSelect: (iconKey: AgentProfileIconKey | null) => void;
}) {
  const handlePress = useCallback(() => onSelect(iconKey), [iconKey, onSelect]);
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  const cellStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.cell,
      Boolean(hovered) && styles.cellHovered,
      pressed && styles.cellPressed,
      selected && styles.cellSelected,
    ],
    [selected],
  );
  return (
    <Pressable
      onPress={handlePress}
      style={cellStyle}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      accessibilityLabel={iconKey ?? "default"}
      testID={`agent-profile-icon-cell-${iconKey ?? "default"}`}
    >
      <AgentProfileGlyph
        {...(iconKey ? { icon: iconKey } : {})}
        color={color}
        size={ICON_SIZE.lg}
      />
    </Pressable>
  );
}

function ColorCell({
  color,
  selected,
  onSelect,
}: {
  color: AgentProfileColor;
  selected: boolean;
  onSelect: (color: AgentProfileColor) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onSelect(color), [color, onSelect]);
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  const swatchStyle = useMemo(
    () => [styles.swatch, color === "none" ? styles.swatchNone : identitySwatch(color)],
    [color],
  );
  const cellStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [styles.colorCell, pressed && styles.cellPressed],
    [],
  );
  return (
    <Pressable
      onPress={handlePress}
      style={cellStyle}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      accessibilityLabel={colorLabel(t, color)}
      testID={`agent-profile-color-cell-${color}`}
    >
      <View style={swatchStyle}>
        {selected ? (
          <ThemedCheck
            size={ICON_SIZE.sm}
            uniProps={color === "none" ? foregroundMutedMapping : onIdentityMapping}
          />
        ) : null}
      </View>
    </Pressable>
  );
}

/**
 * Icon and colour in one popover rather than two fields: the pair is a single
 * visual decision, and picking them apart means never seeing the result until
 * both are closed. The grid redraws in the chosen colour as you switch colours,
 * so the swatch row sits above it.
 */
export function AgentProfileAppearanceField({
  label,
  icon,
  color,
  onChange,
  size = "md",
  disabled = false,
  testID,
  triggerTestID,
}: {
  label: string;
  icon: string;
  color: string;
  onChange: (next: { icon: string; color: string }) => void;
  size?: FieldControlSize;
  disabled?: boolean;
  testID?: string;
  triggerTestID?: string;
}): ReactElement {
  const { t } = useTranslation();
  const anchorRef = useRef<View>(null);
  const [open, setOpen] = useState(false);
  const selectedIcon = resolveAgentProfileIconKey(icon);
  const selectedColor = resolveAgentProfileColor(color);

  const handleTriggerPress = useCallback(() => {
    if (disabled) {
      return;
    }
    setOpen((current) => !current);
  }, [disabled]);

  // Colour keeps the popover open — you are still choosing. An icon is the last
  // decision, so it commits and closes.
  const handleColorSelect = useCallback(
    (next: AgentProfileColor) => onChange({ icon, color: next === "none" ? "" : next }),
    [icon, onChange],
  );
  const handleIconSelect = useCallback(
    (next: AgentProfileIconKey | null) => {
      onChange({ icon: next ?? "", color });
      setOpen(false);
    },
    [color, onChange],
  );

  const triggerStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.trigger,
      size === "sm" ? styles.triggerSm : styles.triggerMd,
      styles.triggerIconOnly,
      resolveControlInteractionStyles(
        {
          controlRest: styles.controlRest,
          controlHover: styles.controlHover,
          controlActive: styles.controlActive,
          controlDisabled: styles.controlDisabled,
        },
        { hovered: Boolean(hovered), active: pressed || open, disabled },
      ),
    ],
    [disabled, open, size],
  );

  const header = useMemo(() => ({ title: label }), [label]);

  return (
    <Field label={label} testID={testID}>
      <View ref={anchorRef} collapsable={false}>
        <Pressable
          onPress={handleTriggerPress}
          disabled={disabled}
          style={triggerStyle}
          accessibilityRole="button"
          accessibilityLabel={`${label} (${colorLabel(t, selectedColor)})`}
          testID={triggerTestID}
        >
          <AgentProfileGlyph
            {...(selectedIcon ? { icon: selectedIcon } : {})}
            color={selectedColor}
            size={ICON_SIZE.md}
          />
          <ThemedChevronDown size={ICON_SIZE.sm} uniProps={foregroundMutedMapping} />
        </Pressable>
      </View>
      <Combobox
        options={EMPTY_COMBOBOX_OPTIONS}
        value=""
        onSelect={noop}
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        header={header}
        desktopMinWidth={DESKTOP_WIDTH}
        desktopLockWidth
      >
        <View style={styles.body} testID="agent-profile-appearance-picker">
          <View style={styles.colorRow}>
            {AGENT_PROFILE_COLORS.map((option) => (
              <ColorCell
                key={option}
                color={option}
                selected={option === selectedColor}
                onSelect={handleColorSelect}
              />
            ))}
          </View>
          <View style={styles.grid}>
            <IconCell
              iconKey={null}
              selected={selectedIcon === null}
              color={selectedColor}
              onSelect={handleIconSelect}
            />
            {AGENT_PROFILE_ICON_KEYS.map((key) => (
              <IconCell
                key={key}
                iconKey={key}
                selected={key === selectedIcon}
                color={selectedColor}
                onSelect={handleIconSelect}
              />
            ))}
          </View>
        </View>
      </Combobox>
    </Field>
  );
}

function noop() {}

/**
 * One named rule per hue. Unistyles cannot resolve a colour computed at render,
 * so the palette has to be spelled out as static styles.
 */
function identitySwatch(color: Exclude<AgentProfileColor, "none">) {
  return IDENTITY_SWATCH_STYLES[color];
}

const styles = StyleSheet.create((theme) => {
  const geometry = createControlGeometry(theme);

  return {
    trigger: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: theme.spacing[1],
      backgroundColor: theme.colors.surface2,
    },
    triggerSm: { ...geometry.fieldControlSm },
    triggerMd: { ...geometry.fieldControlMd },
    // The field geometry pads for a line of text. This trigger holds a glyph and
    // a chevron, so it keeps the shared height and drops the text-sized inset.
    triggerIconOnly: {
      paddingHorizontal: theme.spacing[2],
    },
    controlRest: { ...geometry.controlRest },
    controlHover: { ...geometry.controlHover },
    controlActive: { ...geometry.controlActive },
    controlDisabled: { ...geometry.controlDisabled },

    body: {
      padding: CELL_GRID_PADDING,
      gap: theme.spacing[3],
    },
    colorRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: CELL_GAP,
      paddingBottom: theme.spacing[3],
      borderBottomWidth: theme.borderWidth[1],
      borderBottomColor: theme.colors.border,
    },
    colorCell: {
      width: COLOR_CELL_SIZE,
      height: COLOR_CELL_SIZE,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: theme.borderRadius.md,
    },
    grid: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: CELL_GAP,
    },
    cell: {
      width: CELL_SIZE,
      height: CELL_SIZE,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: theme.borderRadius.md,
      borderWidth: theme.borderWidth[1],
      borderColor: "transparent",
    },
    cellHovered: {
      backgroundColor: theme.colors.surface2,
    },
    cellPressed: {
      opacity: 0.7,
    },
    cellSelected: {
      backgroundColor: theme.colors.surface2,
      borderColor: theme.colors.border,
    },
    swatch: {
      width: SWATCH_SIZE,
      height: SWATCH_SIZE,
      borderRadius: SWATCH_SIZE / 2,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: theme.borderWidth[1],
      borderColor: theme.colors.border,
    },
    swatchNone: {
      backgroundColor: theme.colors.surface2,
    },
    swatchViolet: { backgroundColor: identityForeground("violet", theme.colorScheme) },
    swatchSky: { backgroundColor: identityForeground("sky", theme.colorScheme) },
    swatchEmerald: { backgroundColor: identityForeground("emerald", theme.colorScheme) },
    swatchOrange: { backgroundColor: identityForeground("orange", theme.colorScheme) },
    swatchPink: { backgroundColor: identityForeground("pink", theme.colorScheme) },
    swatchIndigo: { backgroundColor: identityForeground("indigo", theme.colorScheme) },
    swatchTeal: { backgroundColor: identityForeground("teal", theme.colorScheme) },
    swatchRed: { backgroundColor: identityForeground("red", theme.colorScheme) },
    swatchAmber: { backgroundColor: identityForeground("amber", theme.colorScheme) },
    swatchBlue: { backgroundColor: identityForeground("blue", theme.colorScheme) },
  };
});

const IDENTITY_SWATCH_STYLES = {
  violet: styles.swatchViolet,
  sky: styles.swatchSky,
  emerald: styles.swatchEmerald,
  orange: styles.swatchOrange,
  pink: styles.swatchPink,
  indigo: styles.swatchIndigo,
  teal: styles.swatchTeal,
  red: styles.swatchRed,
  amber: styles.swatchAmber,
  blue: styles.swatchBlue,
} as const;
