import type { MarkdownStyle } from './types/MarkdownStyle';
import type {
  BlockTextAlign,
  EmphasisFontStyle,
  LinkVariantEntryInternal,
  MarkdownStyleInternal,
} from './types/MarkdownStyleInternal';
import { isStyleEqual, mergeSubStyle } from './styleUtils';
import {
  normalizeLinkVariantEntries,
  normalizeLinkPillStyle,
} from './linkVariantUtils';
import { resolveAdmonitionColors } from './admonitionDefaults';
import {
  DEFAULT_HEADING_FONT_WEIGHT,
  HEADING_DEFAULTS,
} from './headingDefaults';

const SYSTEM_FONT =
  'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const MONOSPACE_FONT =
  'ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, Consolas, "DejaVu Sans Mono", monospace';

const defaultTextColor = '#1F2937';

const baseHeader: {
  fontFamily: string;
  fontWeight: string;
  marginTop: number;
  marginBottom: number;
  textAlign: BlockTextAlign;
} = {
  fontFamily: SYSTEM_FONT,
  fontWeight: DEFAULT_HEADING_FONT_WEIGHT,
  marginTop: 0,
  marginBottom: 8,
  textAlign: 'auto',
};

const DEFAULT_NORMALIZED_STYLE: MarkdownStyleInternal = Object.freeze({
  paragraph: {
    fontSize: 16,
    fontFamily: SYSTEM_FONT,
    fontWeight: '',
    color: defaultTextColor,
    lineHeight: 26,
    marginTop: 0,
    marginBottom: 16,
    textAlign: 'auto' as BlockTextAlign,
  },
  h1: {
    ...baseHeader,
    fontSize: HEADING_DEFAULTS.h1.fontSize,
    color: HEADING_DEFAULTS.h1.color,
    lineHeight: 38,
  },
  h2: {
    ...baseHeader,
    fontSize: HEADING_DEFAULTS.h2.fontSize,
    color: HEADING_DEFAULTS.h2.color,
    lineHeight: 32,
  },
  h3: {
    ...baseHeader,
    fontSize: HEADING_DEFAULTS.h3.fontSize,
    color: HEADING_DEFAULTS.h3.color,
    lineHeight: 28,
  },
  h4: {
    ...baseHeader,
    fontSize: HEADING_DEFAULTS.h4.fontSize,
    color: HEADING_DEFAULTS.h4.color,
    lineHeight: 26,
  },
  h5: {
    ...baseHeader,
    fontSize: HEADING_DEFAULTS.h5.fontSize,
    color: HEADING_DEFAULTS.h5.color,
    lineHeight: 24,
  },
  h6: {
    ...baseHeader,
    fontSize: HEADING_DEFAULTS.h6.fontSize,
    color: HEADING_DEFAULTS.h6.color,
    lineHeight: 22,
  },
  blockquote: {
    fontSize: 16,
    fontFamily: SYSTEM_FONT,
    fontWeight: '',
    color: '#4B5563',
    lineHeight: 26,
    marginTop: 0,
    marginBottom: 16,
    borderColor: '#D1D5DB',
    borderWidth: 3,
    gapWidth: 16,
    backgroundColor: '#F9FAFB',
    borderRadius: 0,
    padding: 0,
    admonitions: resolveAdmonitionColors(undefined),
  },
  list: {
    fontSize: 16,
    fontFamily: SYSTEM_FONT,
    fontWeight: '',
    color: defaultTextColor,
    lineHeight: 26,
    marginTop: 0,
    marginBottom: 16,
    bulletColor: '#6B7280',
    bulletSize: 6,
    markerMinWidth: 0,
    markerColor: '#6B7280',
    markerFontWeight: '500',
    gapWidth: 12,
    marginLeft: 24,
    itemSpacing: 0,
  },
  codeBlock: {
    fontSize: 14,
    fontFamily: MONOSPACE_FONT,
    fontWeight: '',
    color: '#F3F4F6',
    lineHeight: 22,
    marginTop: 0,
    marginBottom: 16,
    backgroundColor: '#1F2937',
    borderColor: '#374151',
    borderRadius: 8,
    borderWidth: 1,
    padding: 16,
    syntaxColors: {
      keyword: '#FF7B72',
      operatorColor: '#F3F4F6',
      punctuation: '#F3F4F6',
      string: '#A5D6FF',
      number: '#79C0FF',
      constant: '#79C0FF',
      comment: '#8B949E',
      function: '#D2A8FF',
      type: '#FFA657',
      variable: '#F3F4F6',
      property: '#79C0FF',
      tag: '#7EE787',
      attribute: '#79C0FF',
      embedded: '#F3F4F6',
    },
  },
  link: {
    fontFamily: '',
    color: '#2563EB',
    underline: true,
    backgroundColor: 'transparent',
  },
  linkVariants: [],
  strong: { fontFamily: '', fontWeight: 'bold', color: undefined },
  em: {
    fontFamily: '',
    fontStyle: 'italic' as EmphasisFontStyle,
    color: undefined,
  },
  strikethrough: { color: '#9CA3AF' },
  underline: { color: defaultTextColor },
  code: {
    fontFamily: MONOSPACE_FONT,
    fontSize: 0,
    fontScale: 1,
    color: '#E01E5A',
    backgroundColor: '#FDF2F4',
    borderColor: '#F8D7DA',
  },
  image: {
    height: 200,
    maxHeight: 0,
    aspectRatio: 0,
    resizeMode: '' as const,
    borderRadius: 8,
    marginTop: 0,
    marginBottom: 16,
  },
  video: {
    marginTop: 0,
    marginBottom: 16,
    borderRadius: 8,
    aspectRatio: 16 / 9,
    backgroundColor: '#000000',
  },
  inlineImage: { size: 20 },
  thematicBreak: {
    color: '#E5E7EB',
    height: 1,
    marginTop: 24,
    marginBottom: 24,
  },
  table: {
    fontSize: 14,
    fontFamily: SYSTEM_FONT,
    fontWeight: '',
    color: defaultTextColor,
    marginTop: 0,
    marginBottom: 16,
    lineHeight: 22,
    headerFontFamily: '',
    headerBackgroundColor: '#F3F4F6',
    headerTextColor: '#111827',
    rowEvenBackgroundColor: '#FFFFFF',
    rowOddBackgroundColor: '#F9FAFB',
    borderColor: '#E5E7EB',
    borderWidth: 1,
    borderRadius: 6,
    cellPaddingHorizontal: 12,
    cellPaddingVertical: 8,
    horizontalOverflow: 0,
    align: '' as const,
  },
  math: {
    fontSize: 20,
    color: defaultTextColor,
    backgroundColor: '#F3F4F6',
    padding: 12,
    marginTop: 0,
    marginBottom: 16,
    textAlign: 'center' as BlockTextAlign,
  },
  inlineMath: { color: defaultTextColor },
  taskList: {
    checkedColor: '#007AFF',
    borderColor: '#9E9E9E',
    checkboxSize: 14,
    checkboxBorderRadius: 3,
    checkmarkColor: '#FFFFFF',
    checkedTextColor: '#000000',
    checkedStrikethrough: false,
  },
  // Spoiler rendering is not supported on web yet — defaults kept for type compatibility.
  spoiler: {
    color: '#374151',
    particles: { density: 8, speed: 20 },
    solid: { borderRadius: 4 },
  },
  superscript: { fontScale: 0.75, baselineOffsetScale: 0.35 },
  subscript: { fontScale: 0.75, baselineOffsetScale: 0.2 },
  highlight: {
    color: defaultTextColor,
    backgroundColor: '#FEF08A',
  },
});

const refCache = new WeakMap<MarkdownStyle, MarkdownStyleInternal>();
const structuralCache: {
  style: MarkdownStyle;
  result: MarkdownStyleInternal;
}[] = [];
const LRU_MAX = 8;

const styleReferenceKeys = Object.keys(DEFAULT_NORMALIZED_STYLE);

export const normalizeMarkdownStyle = (
  style: MarkdownStyle
): MarkdownStyleInternal => {
  if (!style || Object.keys(style).length === 0)
    return DEFAULT_NORMALIZED_STYLE;

  const refHit = refCache.get(style);
  if (refHit) return refHit;

  const structIdx = structuralCache.findIndex((e) =>
    isStyleEqual(e.style, style, styleReferenceKeys)
  );
  if (structIdx !== -1) {
    const entry = structuralCache.splice(structIdx, 1)[0]!;
    structuralCache.unshift(entry);
    refCache.set(style, entry.result);
    return entry.result;
  }

  const result: Record<string, unknown> = {};
  (
    Object.keys(DEFAULT_NORMALIZED_STYLE) as (keyof MarkdownStyleInternal)[]
  ).forEach((key) => {
    if (Array.isArray(DEFAULT_NORMALIZED_STYLE[key])) return;
    const userValue = style[key] as unknown as
      | Record<string, unknown>
      | undefined;
    result[key] = mergeSubStyle(
      DEFAULT_NORMALIZED_STYLE[key] as unknown as Record<string, unknown>,
      userValue as Record<string, unknown> | undefined
    );
  });

  // Normalize variants longest-pattern-first so specific patterns win.
  const linkBase = result.link as MarkdownStyleInternal['link'];
  result.linkVariants = normalizeLinkVariantEntries(style.linkVariants).map(
    ([pattern, override]): LinkVariantEntryInternal => {
      return {
        pattern,
        pill: normalizeLinkPillStyle(override),
        fontFamily: override.fontFamily ?? linkBase.fontFamily,
        color: override.color ?? linkBase.color,
        underline: override.underline ?? linkBase.underline,
        backgroundColor: override.backgroundColor ?? 'transparent',
      };
    }
  );

  if (style.taskList?.checkboxSize === undefined) {
    const listSize = (result.list as { fontSize: number }).fontSize;
    (result.taskList as { checkboxSize: number }).checkboxSize = Math.round(
      listSize * 0.9
    );
  }

  // maxHeight/aspectRatio sizing is resize-mode driven; default to 'cover'.
  const image = result.image as MarkdownStyleInternal['image'];
  if (!image.resizeMode && (image.maxHeight > 0 || image.aspectRatio > 0)) {
    (result.image as { resizeMode: string }).resizeMode = 'cover';
  }

  if (!style.highlight?.color) {
    const paragraphColor = (
      result.paragraph as MarkdownStyleInternal['paragraph']
    ).color;
    (result.highlight as MarkdownStyleInternal['highlight']).color =
      paragraphColor;
  }

  // Admonition colors are nested two levels deep (blockquote.admonitions.<type>),
  // deeper than mergeSubStyle merges, so resolve the full per-type palette here.
  (result.blockquote as MarkdownStyleInternal['blockquote']).admonitions =
    resolveAdmonitionColors(
      style.blockquote?.admonitions
    ) as MarkdownStyleInternal['blockquote']['admonitions'];

  // The public API exposes `operator`, but the internal token is `operatorColor`
  // (`operator` is reserved in the generated C++ struct). Remap it after merge.
  const syntaxColors = (
    result.codeBlock as { syntaxColors?: Record<string, unknown> }
  ).syntaxColors;
  if (syntaxColors && 'operator' in syntaxColors) {
    syntaxColors.operatorColor = syntaxColors.operator;
    delete syntaxColors.operator;
  }

  const finalResult = Object.freeze(result) as unknown as MarkdownStyleInternal;
  refCache.set(style, finalResult);
  structuralCache.unshift({ style, result: finalResult });
  if (structuralCache.length > LRU_MAX) structuralCache.pop();

  return finalResult;
};
