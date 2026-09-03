import { useEffect } from "react";
import { withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { getFindHighlights, type FindHighlightColors } from "./highlights.web";

function FindHighlightColorsEffect({ match, active }: FindHighlightColors) {
  useEffect(() => {
    getFindHighlights().setColors({ match, active });
  }, [active, match]);
  return null;
}

/**
 * Keeps the document-level find highlight rules on the current theme.
 *
 * The highlight registry owns a plain `<style>` element, which no Unistyles path can
 * repaint on its own. Wrapping this leaf is what makes the two colors follow a theme
 * change without re-rendering the surface that mounted it.
 */
export const FindHighlightColorsSync = withUnistyles(FindHighlightColorsEffect, (theme: Theme) => ({
  match: theme.colors.findMatch,
  active: theme.colors.findMatchActive,
}));
