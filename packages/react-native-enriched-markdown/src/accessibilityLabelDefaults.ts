import type {
  AccessibilityLabels,
  ResolvedAccessibilityLabels,
} from './types/AccessibilityLabels';

/**
 * Default strings spoken by VoiceOver / TalkBack when the consumer does not
 * provide an override. See `AccessibilityLabels` for the placeholder syntax
 * and the rationale for the no-plural cardinal form.
 */
export const DEFAULT_ACCESSIBILITY_LABELS: ResolvedAccessibilityLabels = {
  list: {
    bulletPoint: 'Bullet point',
    nestedBulletPoint: 'Nested bullet point',
    orderedItem: 'List item {n}',
    nestedOrderedItem: 'Nested list item {n}',
  },
  blockquote: {
    quote: 'Blockquote',
    nestedQuote: 'Nested blockquote',
  },
  table: {
    row: 'Row {n}: {content}',
  },
  math: {
    equation: 'Math: {latex}',
  },
  rotor: {
    headings: 'Headings',
    links: 'Links',
    images: 'Images',
  },
};

/**
 * Resolves a partial `AccessibilityLabels` against `DEFAULT_ACCESSIBILITY_LABELS`,
 * returning a fully-populated struct that native code can consume without any
 * null checks. Override resolution is shallow per sub-group: if a consumer
 * passes `{ list: { bulletPoint: 'Punkt' } }`, only that one field changes and
 * the other list entries fall back to the defaults.
 */
export function resolveAccessibilityLabels(
  labels: AccessibilityLabels | undefined
): ResolvedAccessibilityLabels {
  return {
    list: {
      bulletPoint:
        labels?.list?.bulletPoint ??
        DEFAULT_ACCESSIBILITY_LABELS.list.bulletPoint,
      nestedBulletPoint:
        labels?.list?.nestedBulletPoint ??
        DEFAULT_ACCESSIBILITY_LABELS.list.nestedBulletPoint,
      orderedItem:
        labels?.list?.orderedItem ??
        DEFAULT_ACCESSIBILITY_LABELS.list.orderedItem,
      nestedOrderedItem:
        labels?.list?.nestedOrderedItem ??
        DEFAULT_ACCESSIBILITY_LABELS.list.nestedOrderedItem,
    },
    blockquote: {
      quote:
        labels?.blockquote?.quote ??
        DEFAULT_ACCESSIBILITY_LABELS.blockquote.quote,
      nestedQuote:
        labels?.blockquote?.nestedQuote ??
        DEFAULT_ACCESSIBILITY_LABELS.blockquote.nestedQuote,
    },
    table: {
      row: labels?.table?.row ?? DEFAULT_ACCESSIBILITY_LABELS.table.row,
    },
    math: {
      equation:
        labels?.math?.equation ?? DEFAULT_ACCESSIBILITY_LABELS.math.equation,
    },
    rotor: {
      headings:
        labels?.rotor?.headings ?? DEFAULT_ACCESSIBILITY_LABELS.rotor.headings,
      links: labels?.rotor?.links ?? DEFAULT_ACCESSIBILITY_LABELS.rotor.links,
      images:
        labels?.rotor?.images ?? DEFAULT_ACCESSIBILITY_LABELS.rotor.images,
    },
  };
}
