/**
 * Strings spoken by VoiceOver (iOS) / TalkBack (Android) when navigating
 * the rendered markdown.
 *
 * Every key is optional — when omitted, defaults from
 * `accessibilityLabelDefaults.ts` are applied on the JS side before being
 * forwarded to native. Native code can rely on every field being a concrete
 * string at the point it is consumed.
 *
 * **Placeholder syntax.** Where a label has dynamic content, the default uses
 * `{n}` (count / index, 1-based), `{content}` (resolved cell text or similar),
 * or `{latex}` (math source). Translations must preserve the placeholder names
 * exactly — native code substitutes them at speak time.
 *
 * **No plurals.** Defaults intentionally use the cardinal form (`"Row 2"`,
 * `"List item 2"`) instead of ordinals or count-aware variants. Screen readers
 * already announce numbers locale-appropriately, and a single template avoids
 * the per-language plural rules (en `1/2+`, pl `1/2-4/5+`, ar `0/1/2/3-10/11-99/100+`, …).
 *
 * The shape is split into logical sub-groups so that consumers can override
 * just the announcements that matter to them without re-declaring the rest.
 */
export interface AccessibilityLabels {
  /** Labels spoken for list items. iOS + Android. */
  list?: {
    /** @default 'Bullet point' */
    bulletPoint?: string;
    /**
     * Spoken when the bullet is inside another list.
     * @default 'Nested bullet point'
     */
    nestedBulletPoint?: string;
    /**
     * `{n}` → 1-based item number.
     * @default 'List item {n}'
     */
    orderedItem?: string;
    /**
     * `{n}` → 1-based item number.
     * @default 'Nested list item {n}'
     */
    nestedOrderedItem?: string;
  };

  /** Labels appended for content inside a blockquote. iOS + Android. */
  blockquote?: {
    /**
     * Spoken for top-level blockquote content.
     * @default 'Blockquote'
     */
    quote?: string;
    /**
     * Spoken for content nested inside another blockquote.
     * @default 'Nested blockquote'
     */
    nestedQuote?: string;
  };

  /** Labels spoken for tables. iOS + Android. */
  table?: {
    /**
     * `{n}` → 1-based row index, `{content}` → comma-joined cell texts.
     * @default 'Row {n}: {content}'
     */
    row?: string;
  };

  /** Labels spoken for math equations. iOS + Android. */
  math?: {
    /**
     * `{latex}` → equation source.
     * @default 'Math: {latex}'
     */
    equation?: string;
  };

  /**
   * Labels for the VoiceOver rotor (the secondary jump-by-type navigator on iOS).
   * iOS only — Android has no rotor concept.
   */
  rotor?: {
    /** @default 'Headings' */
    headings?: string;
    /** @default 'Links' */
    links?: string;
    /** @default 'Images' */
    images?: string;
  };
}

/**
 * Fully-populated counterpart of `AccessibilityLabels` — every leaf field is a
 * concrete string. Produced by `resolveAccessibilityLabels()` and what native
 * code should be wired to consume.
 */
export interface ResolvedAccessibilityLabels {
  list: {
    bulletPoint: string;
    nestedBulletPoint: string;
    orderedItem: string;
    nestedOrderedItem: string;
  };
  blockquote: {
    quote: string;
    nestedQuote: string;
  };
  table: {
    row: string;
  };
  math: {
    equation: string;
  };
  rotor: {
    headings: string;
    links: string;
    images: string;
  };
}
