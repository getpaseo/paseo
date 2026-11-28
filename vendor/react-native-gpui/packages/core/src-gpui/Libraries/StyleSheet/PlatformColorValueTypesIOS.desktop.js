/**
 * @flow strict-local
 * @format
 */

import type { ColorValue } from './StyleSheet';

import { DynamicColorIOSPrivate } from './PlatformColorValueTypes';

export type DynamicColorIOSTuple = {
  light: ColorValue,
  dark: ColorValue,
  highContrastLight?: ColorValue,
  highContrastDark?: ColorValue,
};

export const DynamicColorIOS = (tuple: DynamicColorIOSTuple): ColorValue => {
  return DynamicColorIOSPrivate({
    light: tuple.light,
    dark: tuple.dark,
    highContrastLight: tuple.highContrastLight,
    highContrastDark: tuple.highContrastDark,
  });
};
