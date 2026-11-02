/**
 * The tokens a custom context menu draws with.
 *
 * Every field is a plain value so an app can override any subset from
 * `desktop.json` or at runtime. Merging skips `undefined` rather than treating
 * it as "erase": an override object that only names a colour must not blank the
 * font family, which is what a spread merge would do.
 *
 * @format
 */

import type { ColorValue } from 'react-native';

export interface MenuTheme {
  background: ColorValue;
  foreground: ColorValue;
  mutedForeground: ColorValue;
  separator: ColorValue;
  border: ColorValue;
  highlightBackground: ColorValue;
  highlightForeground: ColorValue;
  disabledForeground: ColorValue;
  shadow: ColorValue;
  fontFamily?: string;
  fontSize: number;
  rowHeight: number;
  paddingX: number;
  paddingY: number;
  radius: number;
  minWidth: number;
  maxWidth: number;
}

/**
 * A partial theme per colour scheme, which is the shape
 * `ContextMenu.setTheme({ light, dark })` stores.
 */
export interface MenuThemeSet {
  light?: Partial<MenuTheme>;
  dark?: Partial<MenuTheme>;
}

export const light: MenuTheme = {
  background: '#ffffff',
  foreground: '#1f2328',
  mutedForeground: '#6b7280',
  separator: 'rgba(0, 0, 0, 0.10)',
  border: 'rgba(0, 0, 0, 0.14)',
  highlightBackground: '#2563eb',
  highlightForeground: '#ffffff',
  disabledForeground: 'rgba(0, 0, 0, 0.35)',
  shadow: 'rgba(0, 0, 0, 0.22)',
  fontFamily: undefined,
  fontSize: 13,
  rowHeight: 26,
  paddingX: 12,
  paddingY: 4,
  radius: 6,
  minWidth: 180,
  maxWidth: 320,
};

export const dark: MenuTheme = {
  background: '#1f2125',
  foreground: '#f2f3f5',
  mutedForeground: '#a3a8b0',
  separator: 'rgba(255, 255, 255, 0.10)',
  border: 'rgba(255, 255, 255, 0.14)',
  highlightBackground: '#3b82f6',
  highlightForeground: '#ffffff',
  disabledForeground: 'rgba(255, 255, 255, 0.35)',
  shadow: 'rgba(0, 0, 0, 0.5)',
  fontFamily: undefined,
  fontSize: 13,
  rowHeight: 26,
  paddingX: 12,
  paddingY: 4,
  radius: 6,
  minWidth: 180,
  maxWidth: 320,
};

/**
 * Overlay `override` on `base`. A field explicitly set to `undefined` keeps the
 * base value, so an app can build an override from optional props without
 * knowing which fields happen to be absent.
 */
export function mergeTheme(
  base: MenuTheme,
  override?: Partial<MenuTheme>,
): MenuTheme {
  if (override == null) {
    return { ...base };
  }
  const merged: MenuTheme = { ...base };
  for (const key of Object.keys(override) as Array<keyof MenuTheme>) {
    const value = override[key];
    if (value !== undefined) {
      // The token types differ (numbers, colours and the font family), so the
      // assignment is one place where the compiler cannot narrow per key.
      (merged as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

/**
 * The theme for a color scheme. An unknown scheme (React Native reports `null`
 * before the platform has answered) uses light, matching the native menus'
 * default appearance.
 */
export function themeForScheme(
  scheme: 'light' | 'dark' | null | undefined,
  overrides?: MenuThemeSet,
): MenuTheme {
  const isDark = scheme === 'dark';
  return mergeTheme(
    isDark ? dark : light,
    overrides?.[isDark ? 'dark' : 'light'],
  );
}
