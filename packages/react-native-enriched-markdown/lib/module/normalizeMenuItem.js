"use strict";

// Not __DEV__-gated on purpose: deprecation warnings need to surface in
// staging/TestFlight/CI prod builds too.
const warned = new Set();
const warnOnce = (key, msg) => {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(msg);
};
// TODO: revisit grouping cross-cutting utilities (this, styleUtils, linkVariantUtils,
// normalizeMarkdownStyle, etc.) into a shared module once the set grows further.
export const normalizeMenuItem = (raw, defaultEnabled, defaultLabel) => {
  if (raw === undefined) return {
    enabled: defaultEnabled,
    label: defaultLabel
  };
  // Validate per leaf so an empty string stays an empty string (an emoji-only
  // item is a legitimate use case), while null / non-object / wrong-typed
  // fields fall back to defaults — `getBoolean` on the Android side throws on
  // non-booleans, and a null root would crash JS on property access.
  const obj = typeof raw === 'object' && raw !== null ? raw : {};
  return {
    enabled: typeof obj.enabled === 'boolean' ? obj.enabled : defaultEnabled,
    label: typeof obj.label === 'string' ? obj.label : defaultLabel
  };
};
export const normalizeLegacyBooleanMenuItem = (raw, parentProp, field, defaultEnabled, defaultLabel) => {
  if (typeof raw === 'boolean') {
    warnOnce(`${parentProp}.${field}`, `[react-native-enriched-markdown] ${parentProp}.${field} as a boolean is ` + `deprecated; use { enabled: ${raw} }. The boolean form will be removed in 0.8.`);
    return {
      enabled: raw,
      label: defaultLabel
    };
  }
  return normalizeMenuItem(raw, defaultEnabled, defaultLabel);
};
//# sourceMappingURL=normalizeMenuItem.js.map