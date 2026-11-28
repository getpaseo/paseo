"use strict";

import { normalizeColor } from "./styleUtils.js";
// The five GitHub-flavored admonition/alert types, in the order md4c reports
// them (see MD_ADMONITION_TAGS). The `admonitionType` attribute emitted by the
// parser is always one of these lowercase strings.
export const ADMONITION_TYPES = ['note', 'tip', 'important', 'warning', 'caution'];
// GitHub alert palette. Each `color` tints the left accent bar, the title label
// and the icon for that type. Backgrounds default to transparent (no fill) per
// the issue; users opt into a tint via markdownStyle.blockquote.admonitions.
const ADMONITION_COLOR_DEFAULTS = {
  note: '#0969DA',
  tip: '#1A7F37',
  important: '#8250DF',
  warning: '#9A6700',
  caution: '#CF222E'
};
// Merge user overrides over the GitHub defaults and normalize every color, so
// native/web receive a complete, concrete per-type palette. Mirrors the
// linkVariants resolution: `color` falls back to the type default, and an empty
// or omitted `backgroundColor` resolves to transparent (drawn as no fill).
export function resolveAdmonitionColors(user) {
  const transparent = normalizeColor('transparent');
  const result = {};
  for (const type of ADMONITION_TYPES) {
    const override = user?.[type];
    result[type] = {
      color: (override?.color ? normalizeColor(override.color) : undefined) ?? normalizeColor(ADMONITION_COLOR_DEFAULTS[type]),
      backgroundColor: override?.backgroundColor ? normalizeColor(override.backgroundColor) ?? transparent : transparent
    };
  }
  return result;
}
//# sourceMappingURL=admonitionDefaults.js.map