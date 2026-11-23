"use strict";

import { Platform, processColor } from 'react-native';
export const normalizeColor = color => {
  if (!color) return undefined;
  if (Platform.OS === 'web') return color;
  const processed = processColor(color);
  if (processed === null || processed === undefined) {
    if (__DEV__) {
      console.warn(`[MarkdownStyle] Ignoring invalid color value "${color}"; falling back to the default.`);
    }
    return undefined;
  }
  return processed;
};
export function mergeSubStyle(defaultStyle, userStyle) {
  if (!userStyle) return defaultStyle;
  const result = {
    ...defaultStyle,
    ...userStyle
  };
  for (const key in result) {
    const defaultValue = defaultStyle[key];
    const userValue = userStyle[key];
    if (typeof defaultValue === 'object' && defaultValue !== null && !Array.isArray(defaultValue) && typeof userValue === 'object' && userValue !== null && !Array.isArray(userValue)) {
      result[key] = {
        ...defaultValue,
        ...userValue
      };
    }
    if (key.toLowerCase().includes('color')) {
      const value = result[key];
      if (typeof value === 'string') {
        result[key] = normalizeColor(value) ?? defaultValue;
      } else if (value === undefined || value === null) {
        result[key] = defaultValue;
      }
    }
  }
  return result;
}

// Sub-styles nest (linkVariants -> variant -> pill), so compare structurally all the way down.
function isSubStyleEqual(a, b) {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    const valueA = a[key];
    const valueB = b[key];
    if (valueA === valueB) continue;
    if (typeof valueA === 'object' && valueA !== null && typeof valueB === 'object' && valueB !== null && isSubStyleEqual(valueA, valueB)) {
      continue;
    }
    return false;
  }
  return true;
}
export function isStyleEqual(a, b, referenceKeys) {
  for (const key of referenceKeys) {
    const subA = a[key];
    const subB = b[key];
    if (subA === subB) continue;
    if (!subA || !subB) return false;
    if (!isSubStyleEqual(subA, subB)) {
      return false;
    }
  }
  return true;
}
//# sourceMappingURL=styleUtils.js.map