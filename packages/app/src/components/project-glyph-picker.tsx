import { memo, type RefObject, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { type PressableStateCallbackType, View } from "react-native";
import { SvgXml } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { SheetHeader } from "@/components/adaptive-modal-sheet";
import { Combobox, ComboboxEmpty, type ComboboxOption } from "@/components/ui/combobox";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useIsCompactFormFactor } from "@/constants/layout";
import { glyphSvg, type ProjectGlyph, searchProjectGlyphs } from "@/projects/project-glyph-icon";
import { IDENTITY_COLOR_NAMES, identityColor } from "@/styles/identity-colors";
import type { Theme } from "@/styles/theme";

const NO_OPTIONS: ComboboxOption[] = [];
const COLUMNS = 10;
const CELL = 32;
/** Radix glyphs are drawn on a 15pt grid; at 15 they land on whole pixels. */
const GLYPH = 15;
const GRID_PADDING = 8;
/** Room for a classic scrollbar too, so the tenth column never wraps when one is shown. */
const PICKER_WIDTH = COLUMNS * CELL + GRID_PADDING * 2 + 18;
const SELECTED_GLYPH_COLOR = "#ffffff";

const ThemedSvgXml = withUnistyles(SvgXml);
const glyphColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });

export const PROJECT_GLYPH_COLORS = IDENTITY_COLOR_NAMES.map((name) => ({
  name,
  value: identityColor(name),
}));

export interface ProjectGlyphPickerProps {
  anchorRef: RefObject<View | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The glyph on the tile now, null while the project shows a letter or an image. */
  selectedName: string | null;
  color: string;
  onPickGlyph: (name: string) => void;
  onPickColor: (color: string) => void;
}

/**
 * Radix glyphs in a searchable grid, with the tile colors underneath. Picking a glyph closes
 * the picker; picking a color does not, so the two can be tried against each other.
 */
export function ProjectGlyphPicker({
  anchorRef,
  open,
  onOpenChange,
  selectedName,
  color,
  onPickGlyph,
  onPickColor,
}: ProjectGlyphPickerProps) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [query, setQuery] = useState("");
  const glyphs = useMemo(() => searchProjectGlyphs(query), [query]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) setQuery("");
      onOpenChange(next);
    },
    [onOpenChange],
  );

  const handlePickGlyph = useCallback(
    (name: string) => {
      onPickGlyph(name);
      handleOpenChange(false);
    },
    [handleOpenChange, onPickGlyph],
  );

  const header = useMemo<SheetHeader>(
    () => ({
      title: t("settings.project.edit.glyphPickerTitle"),
      search: {
        onChange: setQuery,
        placeholder: t("settings.project.edit.glyphSearch"),
        // In a bottom sheet, focusing the search pulls the sheet up past its footer and raises
        // the keyboard over the grid; there the field is focused on tap instead.
        autoFocus: !isCompact,
        resetKey: open ? "open" : "closed",
        testID: "project-glyph-search",
      },
    }),
    [isCompact, open, t],
  );

  const footer = useMemo(
    () => (
      <View style={styles.colors} accessibilityRole="radiogroup">
        {PROJECT_GLYPH_COLORS.map((swatch) => (
          <ColorSwatch
            key={swatch.name}
            name={swatch.name}
            value={swatch.value}
            selected={swatch.value === color}
            label={t("settings.project.edit.glyphColor", { color: swatch.name })}
            onPress={onPickColor}
          />
        ))}
      </View>
    ),
    [color, onPickColor, t],
  );

  return (
    <Combobox
      options={NO_OPTIONS}
      value=""
      onSelect={noop}
      open={open}
      onOpenChange={handleOpenChange}
      anchorRef={anchorRef}
      header={header}
      footer={footer}
      desktopPlacement="bottom-start"
      desktopMinWidth={PICKER_WIDTH}
      desktopLockWidth
    >
      {glyphs.length === 0 ? (
        <ComboboxEmpty>{t("settings.project.edit.glyphEmpty")}</ComboboxEmpty>
      ) : (
        <View style={styles.grid} testID="project-glyph-picker-grid">
          {glyphs.map((glyph) => (
            <GlyphCell
              key={glyph.name}
              glyph={glyph}
              selected={glyph.name === selectedName}
              color={color}
              onPress={handlePickGlyph}
            />
          ))}
        </View>
      )}
    </Combobox>
  );
}

function noop() {}

const GlyphCell = memo(function GlyphCell({
  glyph,
  selected,
  color,
  onPress,
}: {
  glyph: ProjectGlyph;
  selected: boolean;
  color: string;
  onPress: (name: string) => void;
}) {
  const xml = useMemo(() => glyphSvg(glyph), [glyph]);
  const selectedFill = useMemo(() => ({ backgroundColor: color }), [color]);
  const cellStyle = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.cell,
      (hovered || pressed) && styles.cellHighlighted,
      selected && selectedFill,
    ],
    [selected, selectedFill],
  );
  const handlePress = useCallback(() => onPress(glyph.name), [glyph.name, onPress]);
  const accessibilityState = useMemo(() => ({ selected }), [selected]);

  return (
    <PressHighlight
      style={cellStyle}
      highlightStyle={styles.cellHighlighted}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={glyph.name}
      accessibilityState={accessibilityState}
      aria-selected={selected}
      testID={`project-glyph-${glyph.name}`}
    >
      {selected ? (
        <SvgXml xml={xml} width={GLYPH} height={GLYPH} color={SELECTED_GLYPH_COLOR} />
      ) : (
        <ThemedSvgXml xml={xml} width={GLYPH} height={GLYPH} uniProps={glyphColorMapping} />
      )}
    </PressHighlight>
  );
});

const ColorSwatch = memo(function ColorSwatch({
  name,
  value,
  selected,
  label,
  onPress,
}: {
  name: string;
  value: string;
  selected: boolean;
  label: string;
  onPress: (value: string) => void;
}) {
  const dotStyle = useMemo(() => [styles.swatchDot, { backgroundColor: value }], [value]);
  const ringStyle = useMemo(
    () => [styles.swatchRing, selected && styles.swatchRingSelected],
    [selected],
  );
  const handlePress = useCallback(() => onPress(value), [onPress, value]);
  const accessibilityState = useMemo(() => ({ checked: selected }), [selected]);

  return (
    <PressHighlight
      style={styles.swatch}
      onPress={handlePress}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={accessibilityState}
      aria-checked={selected}
      testID={`project-glyph-color-${name}`}
    >
      <View style={ringStyle}>
        <View style={dotStyle} />
      </View>
    </PressHighlight>
  );
});

const styles = StyleSheet.create((theme) => ({
  grid: {
    width: COLUMNS * CELL,
    alignSelf: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    paddingVertical: GRID_PADDING,
  },
  cell: {
    width: CELL,
    height: CELL,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  cellHighlighted: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  colors: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: theme.spacing[0.5],
    paddingHorizontal: GRID_PADDING,
    paddingVertical: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  swatch: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  swatchRing: {
    width: 22,
    height: 22,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1.5,
    borderColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
  },
  swatchRingSelected: {
    borderColor: theme.colors.foreground,
  },
  swatchDot: {
    width: 15,
    height: 15,
    borderRadius: theme.borderRadius.full,
  },
}));
