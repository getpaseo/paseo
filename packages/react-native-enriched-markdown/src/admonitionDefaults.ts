import { normalizeColor } from './styleUtils';
import type { AdmonitionsStyle } from './types/MarkdownStyle';

// The five GitHub-flavored admonition/alert types, in the order md4c reports
// them (see MD_ADMONITION_TAGS). The `admonitionType` attribute emitted by the
// parser is always one of these lowercase strings.
export const ADMONITION_TYPES = [
  'note',
  'tip',
  'important',
  'warning',
  'caution',
] as const;

export type AdmonitionType = (typeof ADMONITION_TYPES)[number];

// GitHub alert palette. Each `color` tints the left accent bar, the title label
// and the icon for that type. Backgrounds default to transparent (no fill) per
// the issue; users opt into a tint via markdownStyle.blockquote.admonitions.
const ADMONITION_COLOR_DEFAULTS: Record<AdmonitionType, string> = {
  note: '#0969DA',
  tip: '#1A7F37',
  important: '#8250DF',
  warning: '#9A6700',
  caution: '#CF222E',
};

export interface ResolvedAdmonitionColors {
  color: string;
  backgroundColor: string;
}

export type ResolvedAdmonitions = Record<
  AdmonitionType,
  ResolvedAdmonitionColors
>;

// Merge user overrides over the GitHub defaults and normalize every color, so
// native/web receive a complete, concrete per-type palette. Mirrors the
// linkVariants resolution: `color` falls back to the type default, and an empty
// or omitted `backgroundColor` resolves to transparent (drawn as no fill).
export function resolveAdmonitionColors(
  user: AdmonitionsStyle | undefined
): ResolvedAdmonitions {
  const transparent = normalizeColor('transparent')! as string;
  const result = {} as ResolvedAdmonitions;
  for (const type of ADMONITION_TYPES) {
    const override = user?.[type];
    result[type] = {
      color: ((override?.color ? normalizeColor(override.color) : undefined) ??
        normalizeColor(ADMONITION_COLOR_DEFAULTS[type])!) as string,
      backgroundColor: (override?.backgroundColor
        ? (normalizeColor(override.backgroundColor) ?? transparent)
        : transparent) as string,
    };
  }
  return result;
}
