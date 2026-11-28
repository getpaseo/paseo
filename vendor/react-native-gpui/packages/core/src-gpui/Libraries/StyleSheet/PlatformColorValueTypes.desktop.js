/**
 * @flow strict-local
 * @format
 */

import type { ProcessedColorValue } from './processColor';
import type { ColorValue, NativeColorValue } from './StyleSheet';

/** The actual type of the opaque NativeColorValue on desktop. */
type LocalNativeColorValue = {
  semantic?: Array<string>,
  dynamic?: {
    light: ?(ColorValue | ProcessedColorValue),
    dark: ?(ColorValue | ProcessedColorValue),
    highContrastLight?: ?(ColorValue | ProcessedColorValue),
    highContrastDark?: ?(ColorValue | ProcessedColorValue),
  },
};

// Light and dark values for the system colors apps ask for by name: the AppKit
// and UIKit semantic names, the Windows theme resources and the GTK ones.
// A name that is not listed here resolves to the next name given, or to
// transparent.
const SYSTEM_COLORS: { [string]: [string, string] } = {
  label: ['#000000', '#ffffff'],
  labelColor: ['#000000', '#ffffff'],
  secondaryLabel: ['#3c3c4399', '#ebebf599'],
  secondaryLabelColor: ['#0000008c', '#ffffff8c'],
  tertiaryLabel: ['#3c3c434d', '#ebebf54d'],
  tertiaryLabelColor: ['#00000040', '#ffffff40'],
  quaternaryLabel: ['#3c3c432d', '#ebebf529'],
  quaternaryLabelColor: ['#00000019', '#ffffff19'],
  placeholderText: ['#3c3c434d', '#ebebf54d'],
  placeholderTextColor: ['#00000040', '#ffffff40'],
  link: ['#007aff', '#0984ff'],
  linkColor: ['#0068da', '#419cff'],
  separator: ['#3c3c4349', '#54545899'],
  separatorColor: ['#00000019', '#ffffff19'],
  opaqueSeparator: ['#c6c6c8', '#38383a'],
  systemBackground: ['#ffffff', '#000000'],
  secondarySystemBackground: ['#f2f2f7', '#1c1c1e'],
  tertiarySystemBackground: ['#ffffff', '#2c2c2e'],
  systemGroupedBackground: ['#f2f2f7', '#000000'],
  windowBackgroundColor: ['#ececec', '#323232'],
  controlBackgroundColor: ['#ffffff', '#1e1e1e'],
  underPageBackgroundColor: ['#969696e6', '#282828e6'],
  textBackgroundColor: ['#ffffff', '#1e1e1e'],
  textColor: ['#000000', '#ffffff'],
  controlTextColor: ['#000000d8', '#ffffffd8'],
  disabledControlTextColor: ['#00000040', '#ffffff40'],
  selectedTextColor: ['#000000', '#ffffff'],
  selectedTextBackgroundColor: ['#b3d7ff', '#3f638b'],
  controlAccentColor: ['#007aff', '#0a84ff'],
  selectedContentBackgroundColor: ['#0063e1', '#0058d0'],
  unemphasizedSelectedContentBackgroundColor: ['#dcdcdc', '#464646'],
  gridColor: ['#dcdcdc', '#3c3c3c'],
  headerTextColor: ['#000000d8', '#ffffffd8'],
  highlightColor: ['#ffffff', '#ffffff'],
  shadowColor: ['#000000', '#000000'],
  systemRed: ['#ff3b30', '#ff453a'],
  systemRedColor: ['#ff3b30', '#ff453a'],
  systemOrange: ['#ff9500', '#ff9f0a'],
  systemOrangeColor: ['#ff9500', '#ff9f0a'],
  systemYellow: ['#ffcc00', '#ffd60a'],
  systemYellowColor: ['#ffcc00', '#ffd60a'],
  systemGreen: ['#34c759', '#30d158'],
  systemGreenColor: ['#28cd41', '#32d74b'],
  systemMint: ['#00c7be', '#63e6e2'],
  systemTeal: ['#30b0c7', '#40c8e0'],
  systemCyan: ['#32ade6', '#64d2ff'],
  systemBlue: ['#007aff', '#0a84ff'],
  systemBlueColor: ['#007aff', '#0a84ff'],
  systemIndigo: ['#5856d6', '#5e5ce6'],
  systemPurple: ['#af52de', '#bf5af2'],
  systemPurpleColor: ['#af52de', '#bf5af2'],
  systemPink: ['#ff2d55', '#ff375f'],
  systemPinkColor: ['#ff2d55', '#ff375f'],
  systemBrown: ['#a2845e', '#ac8e68'],
  systemGray: ['#8e8e93', '#8e8e93'],
  systemGrayColor: ['#8e8e93', '#98989d'],
  systemGray2: ['#aeaeb2', '#636366'],
  systemGray3: ['#c7c7cc', '#48484a'],
  systemGray4: ['#d1d1d6', '#3a3a3c'],
  systemGray5: ['#e5e5ea', '#2c2c2e'],
  systemGray6: ['#f2f2f7', '#1c1c1e'],
  systemFill: ['#78788033', '#7878805b'],
  secondarySystemFill: ['#78788029', '#78788051'],
  SystemAccentColor: ['#0078d4', '#4cc2ff'],
  SystemAccentColorLight1: ['#2b88d8', '#4cc2ff'],
  SystemAccentColorDark1: ['#005a9e', '#0078d4'],
  SystemBaseHighColor: ['#000000', '#ffffff'],
  SystemBaseMediumColor: ['#666666', '#999999'],
  SystemBaseLowColor: ['#33000000', '#33ffffff'],
  SystemAltHighColor: ['#ffffff', '#000000'],
  SystemChromeLowColor: ['#f2f2f2', '#171717'],
  SystemChromeMediumColor: ['#e6e6e6', '#1f1f1f'],
  SystemChromeWhiteColor: ['#ffffff', '#ffffff'],
  SystemChromeBlackHighColor: ['#000000', '#000000'],
  SystemErrorTextColor: ['#c50500', '#ff99a4'],
  TextFillColorPrimary: ['#e4000000', '#ffffff'],
  TextFillColorSecondary: ['#9e000000', '#c5ffffff'],
  TextFillColorDisabled: ['#5c000000', '#5dffffff'],
  CardBackgroundFillColorDefault: ['#b3ffffff', '#08ffffff'],
  SolidBackgroundFillColorBase: ['#f3f3f3', '#202020'],
  ControlFillColorDefault: ['#b3ffffff', '#0fffffff'],
  theme_bg_color: ['#f6f5f4', '#353535'],
  theme_fg_color: ['#2e3436', '#eeeeec'],
  theme_base_color: ['#ffffff', '#2d2d2d'],
  theme_text_color: ['#2e3436', '#ffffff'],
  theme_selected_bg_color: ['#3584e4', '#15539e'],
  theme_selected_fg_color: ['#ffffff', '#ffffff'],
  borders: ['#00000026', '#00000066'],
  accent_color: ['#3584e4', '#78aeed'],
  accent_bg_color: ['#3584e4', '#3584e4'],
  window_bg_color: ['#fafafa', '#242424'],
  window_fg_color: ['#000000cc', '#ffffff'],
  view_bg_color: ['#ffffff', '#1e1e1e'],
  view_fg_color: ['#000000cc', '#ffffff'],
  headerbar_bg_color: ['#ebebeb', '#303030'],
  card_bg_color: ['#ffffff', '#ffffff14'],
  destructive_color: ['#c01c28', '#ff7b63'],
  success_color: ['#2ec27e', '#8ff0a4'],
  warning_color: ['#e5a50a', '#f8e45c'],
  error_color: ['#c01c28', '#ff7b63'],
};

export const PlatformColor = (...names: Array<string>): NativeColorValue => {
  // $FlowExpectedError[incompatible-type] LocalNativeColorValue is the desktop LocalNativeColorValue type
  return { semantic: names } as LocalNativeColorValue;
};

export type DynamicColorIOSTuplePrivate = {
  light: ColorValue,
  dark: ColorValue,
  highContrastLight?: ColorValue,
  highContrastDark?: ColorValue,
};

export const DynamicColorIOSPrivate = (
  tuple: DynamicColorIOSTuplePrivate,
): ColorValue => {
  return {
    dynamic: {
      light: tuple.light,
      dark: tuple.dark,
      highContrastLight: tuple.highContrastLight,
      highContrastDark: tuple.highContrastDark,
    },
    // $FlowExpectedError[incompatible-type] LocalNativeColorValue is the actual type of the opaque NativeColorValue
  } as LocalNativeColorValue;
};

export const normalizeColorObject = (
  color: NativeColorValue,
): ?ProcessedColorValue => {
  const value = color as LocalNativeColorValue;
  if ('semantic' in value || 'dynamic' in value) {
    return color;
  }
  return null;
};

function isDark(): boolean {
  const Appearance = require('../Utilities/Appearance');
  return Appearance.getColorScheme() === 'dark';
}

// Colors are resolved when a style is processed, against the appearance at
// that moment, so a change in appearance shows on the next render.
export const processColorObject = (
  color: NativeColorValue,
): ?NativeColorValue => {
  const value = color as LocalNativeColorValue;
  const processColor = require('./processColor').default;
  if (value.semantic != null) {
    const dark = isDark();
    for (const name of value.semantic) {
      const pair = SYSTEM_COLORS[name];
      if (pair != null) {
        return processColor(pair[dark ? 1 : 0]);
      }
    }
    return processColor('transparent');
  }
  if (value.dynamic != null) {
    const dark = isDark();
    const chosen = dark ? value.dynamic.dark : value.dynamic.light;
    return processColor(chosen ?? value.dynamic.light ?? 'transparent');
  }
  return color;
};
