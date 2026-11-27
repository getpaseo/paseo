"use strict";

import { normalizeColor } from "./styleUtils.js";
// Lookbehind assertions (?<=...) and (?<!...) are not supported by
// NSRegularExpression on iOS. Warn early so the issue surfaces in JS tests
// before it silently misfires on device.
const UNSAFE_LOOKBEHIND_RE = /\(\?<[=!]/;
function warnAboutUnsafePattern(owner, pattern) {
  if (UNSAFE_LOOKBEHIND_RE.test(pattern)) {
    console.warn(`${owner} pattern "${pattern}" contains a lookbehind assertion (?<= or ?<!). ` + 'Lookbehinds are not supported by NSRegularExpression on iOS and will never match. ' + 'Use a lookahead or restructure the pattern to avoid them.');
  }
}

/**
 * Orders URL patterns the way native tries them: longest first, so the most
 * specific pattern wins. Patterns that are not valid regexes are dropped.
 * `owner` names the prop in warnings.
 */
export function normalizeLinkPatternEntries(entries, owner) {
  return Object.entries(entries ?? {}).sort(([a], [b]) => b.length - a.length).filter(([pattern]) => {
    try {
      RegExp(pattern);
    } catch {
      if (__DEV__) {
        console.warn(`${owner} pattern "${pattern}" is not a valid regex and will be ignored.`);
      }
      return false;
    }
    if (__DEV__) {
      warnAboutUnsafePattern(owner, pattern);
    }
    return true;
  });
}
export function normalizeLinkVariantEntries(linkVariants) {
  return normalizeLinkPatternEntries(linkVariants, '[MarkdownStyle] linkVariants');
}

/** Native pill geometry is finite and nonnegative before crossing codegen. */
export function normalizeLinkPillStyle(style) {
  const hasConfig = typeof style.pill === 'object' && style.pill !== null;
  const config = typeof style.pill === 'object' && style.pill !== null ? style.pill : {};
  const dimension = (value, fallback) => value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, value);
  return {
    enabled: style.pill === true || hasConfig,
    borderColor: config.borderColor ?? 'transparent',
    label: config.label ?? '',
    iconUri: config.iconUri ?? '',
    iconTintColor: config.iconTintColor,
    borderRadius: dimension(config.borderRadius, 8),
    paddingHorizontal: dimension(config.paddingHorizontal, 6),
    paddingVertical: dimension(config.paddingVertical, 2),
    lineHeight: dimension(config.lineHeight, 0),
    borderWidth: dimension(config.borderWidth, 0),
    maxWidth: dimension(config.maxWidth, 0)
  };
}

/** Flattens `linkPillContent` for native; sorted so equal maps produce the same array. */
export function normalizeLinkPillContent(content) {
  if (!content) return undefined;
  return Object.entries(content).map(([url, {
    label,
    iconUri,
    iconTintColor
  }]) => ({
    url,
    label: label ?? '',
    iconUri: iconUri ?? '',
    iconTintColor: normalizeColor(iconTintColor)
  })).sort((a, b) => a.url < b.url ? -1 : a.url > b.url ? 1 : 0);
}
/** Whether two flattened `linkPillContent` arrays hold the same entries. */
export function isLinkPillContentEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((entry, index) => {
    const other = b[index];
    return entry.url === other.url && entry.label === other.label && entry.iconUri === other.iconUri && entry.iconTintColor === other.iconTintColor;
  });
}
//# sourceMappingURL=linkVariantUtils.js.map