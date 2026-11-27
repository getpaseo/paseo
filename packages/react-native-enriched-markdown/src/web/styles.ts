import type { CSSProperties } from 'react';
import type {
  BlockTextAlign,
  MarkdownStyleInternal,
} from '../types/MarkdownStyleInternal';

const normalizeFontFamily = (value: string): string | undefined =>
  value || undefined;

const VALID_FONT_WEIGHTS = new Set([
  'normal',
  'bold',
  'bolder',
  'lighter',
  '100',
  '200',
  '300',
  '400',
  '500',
  '600',
  '700',
  '800',
  '900',
]);

const normalizeFontWeight = (value: string): CSSProperties['fontWeight'] => {
  if (!value) return undefined;
  if (VALID_FONT_WEIGHTS.has(value))
    return value as CSSProperties['fontWeight'];
  return undefined;
};

const normalizeTextAlign = (
  value: BlockTextAlign
): CSSProperties['textAlign'] => (value === 'auto' ? undefined : value);

// 'default' is an AST sentinel for "unspecified column alignment".
function resolveColumnAlign(
  align: 'left' | 'center' | 'right' | 'default' | undefined
): 'left' | 'center' | 'right' {
  if (align === 'center' || align === 'right') return align;
  return 'left';
}

export function zeroTrailingMargins(
  style: MarkdownStyleInternal
): MarkdownStyleInternal {
  return {
    ...style,
    paragraph: { ...style.paragraph, marginBottom: 0 },
    h1: { ...style.h1, marginBottom: 0 },
    h2: { ...style.h2, marginBottom: 0 },
    h3: { ...style.h3, marginBottom: 0 },
    h4: { ...style.h4, marginBottom: 0 },
    h5: { ...style.h5, marginBottom: 0 },
    h6: { ...style.h6, marginBottom: 0 },
    blockquote: { ...style.blockquote, marginBottom: 0 },
    list: { ...style.list, marginBottom: 0 },
    codeBlock: { ...style.codeBlock, marginBottom: 0 },
    thematicBreak: { ...style.thematicBreak, marginBottom: 0 },
    image: { ...style.image, marginBottom: 0 },
    video: { ...style.video, marginBottom: 0 },
    math: { ...style.math, marginBottom: 0 },
    table: { ...style.table, marginBottom: 0 },
  };
}

type HeadingLevel = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';

export function toHeadingLevel(level: string): HeadingLevel {
  const clamped = Math.max(1, Math.min(6, parseInt(level, 10) || 1));
  return `h${clamped}` as HeadingLevel;
}

type BaseBlock = Pick<
  MarkdownStyleInternal['paragraph'],
  | 'fontSize'
  | 'fontFamily'
  | 'fontWeight'
  | 'color'
  | 'lineHeight'
  | 'marginTop'
  | 'marginBottom'
  | 'textAlign'
>;

function baseBlock(block: BaseBlock): CSSProperties {
  return {
    fontSize: block.fontSize,
    fontFamily: normalizeFontFamily(block.fontFamily),
    fontWeight: normalizeFontWeight(block.fontWeight),
    color: block.color,
    lineHeight: `${block.lineHeight}px`,
    marginTop: block.marginTop,
    marginBottom: block.marginBottom,
    textAlign: normalizeTextAlign(block.textAlign),
  };
}

function paragraphStyle(style: MarkdownStyleInternal): CSSProperties {
  return baseBlock(style.paragraph);
}

function paragraphInBlockquoteStyle(
  style: MarkdownStyleInternal
): CSSProperties {
  // Keep the paragraph's block margins so spacing between blocks inside a quote
  // matches the top-level document (e.g. the gap before a heading). The last
  // child's trailing margin is zeroed by a global blockquote :last-child rule
  // (see globalStyles), mirroring native's trailing-margin trim - the quote is a
  // flex-item BFC, so that margin would otherwise not collapse out of the box.
  return baseBlock(style.paragraph);
}

function headingStyle(
  style: MarkdownStyleInternal,
  level: string
): CSSProperties {
  return baseBlock(style[toHeadingLevel(level)]);
}

function blockquoteStyle(style: MarkdownStyleInternal): CSSProperties {
  const blockquote = style.blockquote;
  return {
    fontSize: blockquote.fontSize,
    fontFamily: normalizeFontFamily(blockquote.fontFamily),
    fontWeight: normalizeFontWeight(blockquote.fontWeight),
    color: blockquote.color,
    lineHeight: `${blockquote.lineHeight}px`,
    marginTop: blockquote.marginTop,
    marginBottom: blockquote.marginBottom,
    marginInlineStart: 0, // reset UA default (40px in LTR, auto in RTL)
    marginInlineEnd: 0,
    paddingInlineStart: blockquote.gapWidth + blockquote.padding,
    paddingInlineEnd: blockquote.padding,
    paddingTop: blockquote.padding,
    paddingBottom: blockquote.padding,
    borderInlineStart: `${blockquote.borderWidth}px solid ${blockquote.borderColor}`,
    borderRadius: blockquote.borderRadius,
    backgroundColor: blockquote.backgroundColor,
  };
}

function listStyle(
  style: MarkdownStyleInternal,
  isTaskList = false
): CSSProperties {
  const list = style.list;
  return {
    listStylePosition: 'outside',
    fontSize: list.fontSize,
    fontFamily: normalizeFontFamily(list.fontFamily),
    fontWeight: normalizeFontWeight(list.fontWeight),
    color: list.color,
    lineHeight: `${list.lineHeight}px`,
    marginTop: list.marginTop,
    marginBottom: list.marginBottom,
    paddingInlineStart: isTaskList ? 0 : list.marginLeft,
  };
}

function codeBlockStyle(style: MarkdownStyleInternal): CSSProperties {
  const codeBlock = style.codeBlock;
  return {
    fontSize: codeBlock.fontSize,
    fontFamily: normalizeFontFamily(codeBlock.fontFamily),
    fontWeight: normalizeFontWeight(codeBlock.fontWeight),
    color: codeBlock.color,
    lineHeight: `${codeBlock.lineHeight}px`,
    backgroundColor: codeBlock.backgroundColor,
    border: `${codeBlock.borderWidth}px solid ${codeBlock.borderColor}`,
    borderRadius: codeBlock.borderRadius,
    padding: codeBlock.padding,
    margin: 0,
    marginTop: codeBlock.marginTop,
    marginBottom: codeBlock.marginBottom,
    overflowX: 'auto',
    direction: 'ltr',
  };
}

function thematicBreakStyle(style: MarkdownStyleInternal): CSSProperties {
  const thematicBreak = style.thematicBreak;
  return {
    border: 'none', // reset UA borders on all sides before drawing only the top
    borderTop: `${thematicBreak.height}px solid ${thematicBreak.color}`,
    marginTop: thematicBreak.marginTop,
    marginBottom: thematicBreak.marginBottom,
    width: '100%', // <hr> as a flex item doesn't auto-stretch — must be explicit
  };
}

const RESIZE_MODE_TO_OBJECT_FIT: Record<
  Exclude<MarkdownStyleInternal['image']['resizeMode'], ''>,
  NonNullable<CSSProperties['objectFit']>
> = {
  contain: 'contain',
  cover: 'cover',
  stretch: 'fill',
  center: 'scale-down',
  none: 'none',
};

function imageStyle(style: MarkdownStyleInternal): CSSProperties {
  const image = style.image;
  const base: CSSProperties = {
    borderRadius: image.borderRadius,
    marginTop: image.marginTop,
    marginBottom: image.marginBottom,
    maxWidth: '100%',
    display: 'block',
  };

  // Sizing precedence: aspectRatio > maxHeight > height. resizeMode '' means
  // legacy sizing — emit today's exact CSS for backward compatibility.
  if (image.resizeMode === '') {
    return { ...base, height: image.height };
  }

  const objectFit = RESIZE_MODE_TO_OBJECT_FIT[image.resizeMode] ?? 'cover';

  if (image.aspectRatio > 0) {
    return {
      ...base,
      width: '100%',
      aspectRatio: image.aspectRatio,
      objectFit,
    };
  }

  if (image.maxHeight > 0) {
    return {
      ...base,
      width: '100%',
      height: 'auto',
      maxHeight: image.maxHeight,
      objectFit,
    };
  }

  return { ...base, width: '100%', height: image.height, objectFit };
}

function videoStyle(style: MarkdownStyleInternal): CSSProperties {
  const video = style.video;
  const base: CSSProperties = {
    width: '100%',
    maxWidth: '100%',
    display: 'block',
    borderRadius: video.borderRadius,
    backgroundColor: video.backgroundColor,
    marginTop: video.marginTop,
    marginBottom: video.marginBottom,
  };
  if (video.aspectRatio > 0) {
    base.aspectRatio = video.aspectRatio;
  }
  return base;
}

function inlineImageStyle(style: MarkdownStyleInternal): CSSProperties {
  const size = style.inlineImage.size;
  // Inline images match the line height and keep their aspect ratio, so wide
  // badges stay legible instead of shrinking into a square.
  return {
    width: 'auto',
    height: size,
    maxWidth: '100%',
    verticalAlign: 'middle',
    display: 'inline',
  };
}

function strongStyle(style: MarkdownStyleInternal): CSSProperties {
  const strong = style.strong;
  return {
    fontFamily: normalizeFontFamily(strong.fontFamily),
    fontWeight: normalizeFontWeight(strong.fontWeight) || 'bold',
    color: strong.color ?? style.paragraph.color,
  };
}

function emphasisStyle(style: MarkdownStyleInternal): CSSProperties {
  const emphasis = style.em;
  return {
    fontFamily: normalizeFontFamily(emphasis.fontFamily),
    fontStyle: emphasis.fontStyle || 'italic', // '' means "inherit default" → fall back to italic
    color: emphasis.color ?? style.paragraph.color,
  };
}

function codeStyle(style: MarkdownStyleInternal): CSSProperties {
  const code = style.code;
  return {
    fontFamily: normalizeFontFamily(code.fontFamily),
    fontSize: code.fontSize || `${code.fontScale}em`,
    color: code.color,
    backgroundColor: code.backgroundColor,
    border: `1px solid ${code.borderColor}`,
    borderRadius: 3,
    padding: '1px 4px',
    direction: 'ltr',
    unicodeBidi: 'embed',
  };
}

function linkStyle(style: MarkdownStyleInternal): CSSProperties {
  const link = style.link;
  return {
    color: link.color,
    fontFamily: normalizeFontFamily(link.fontFamily),
    textDecoration: link.underline ? 'underline' : 'none',
  };
}

/** Compiled variant regexes keyed by the normalized style object. Avoids recompiling on every link render. */
const _variantRegexCache = new WeakMap<
  MarkdownStyleInternal['linkVariants'],
  Array<RegExp | null>
>();

function getCompiledVariantRegexes(
  variants: MarkdownStyleInternal['linkVariants']
): Array<RegExp | null> {
  let compiled = _variantRegexCache.get(variants);
  if (!compiled) {
    compiled = variants.map((variant) => {
      try {
        return new RegExp(variant.pattern);
      } catch {
        return null;
      }
    });
    _variantRegexCache.set(variants, compiled);
  }
  return compiled;
}

export function linkStyleForUrl(
  style: MarkdownStyleInternal,
  url: string
): CSSProperties {
  const base = style.link;
  const compiledVariantRegexes = getCompiledVariantRegexes(style.linkVariants);
  const variantIndex = compiledVariantRegexes.findIndex(
    (regex) => regex !== null && regex.test(url)
  );
  const resolved =
    variantIndex !== -1 ? style.linkVariants[variantIndex]! : base;

  const backgroundColor = resolved.backgroundColor;
  return {
    color: resolved.color,
    fontFamily: normalizeFontFamily(resolved.fontFamily),
    textDecoration: resolved.underline ? 'underline' : 'none',
    ...(backgroundColor && backgroundColor !== 'transparent'
      ? { backgroundColor }
      : undefined),
  };
}

function strikethroughStyle(style: MarkdownStyleInternal): CSSProperties {
  return {
    textDecorationLine: 'line-through',
    textDecorationColor: style.strikethrough.color,
  };
}

function underlineStyle(style: MarkdownStyleInternal): CSSProperties {
  return {
    textDecorationLine: 'underline',
    textDecorationColor: style.underline.color,
  };
}

function superscriptStyle(style: MarkdownStyleInternal): CSSProperties {
  const { fontScale, baselineOffsetScale } = style.superscript;
  return {
    fontSize: `${fontScale}em`,
    verticalAlign: `${baselineOffsetScale}em`,
    lineHeight: 0,
  };
}

function subscriptStyle(style: MarkdownStyleInternal): CSSProperties {
  const { fontScale, baselineOffsetScale } = style.subscript;
  return {
    fontSize: `${fontScale}em`,
    verticalAlign: `-${baselineOffsetScale}em`,
    lineHeight: 0,
  };
}

function highlightStyle(style: MarkdownStyleInternal): CSSProperties {
  return {
    backgroundColor: style.highlight.backgroundColor,
    color:
      style.highlight.color !== style.paragraph.color
        ? style.highlight.color
        : 'inherit',
  };
}

function mathInlineStyle(style: MarkdownStyleInternal): CSSProperties {
  return { color: style.inlineMath.color };
}

function mathDisplayStyle(style: MarkdownStyleInternal): CSSProperties {
  const math = style.math;
  return {
    fontSize: math.fontSize,
    color: math.color,
    backgroundColor: math.backgroundColor,
    padding: math.padding,
    marginTop: math.marginTop,
    marginBottom: math.marginBottom,
    textAlign: normalizeTextAlign(math.textAlign),
    overflowX: 'auto',
  };
}

function tableStyle(style: MarkdownStyleInternal): CSSProperties {
  const table = style.table;
  return {
    borderCollapse: 'collapse',
    width: '100%',
    fontSize: table.fontSize,
    fontFamily: normalizeFontFamily(table.fontFamily),
    fontWeight: normalizeFontWeight(table.fontWeight),
    color: table.color,
    lineHeight: `${table.lineHeight}px`,
    border: `${table.borderWidth}px solid ${table.borderColor}`,
  };
}

export function listItemStyle(
  style: MarkdownStyleInternal,
  isTask: boolean,
  isFirstChild: boolean
): CSSProperties | undefined {
  const { itemSpacing } = style.list;
  const marginTop = !isFirstChild && itemSpacing > 0 ? itemSpacing : undefined;
  if (isTask) {
    return { listStyle: 'none', marginTop };
  }
  return marginTop !== undefined ? { marginTop } : undefined;
}

export function checkedTaskTextStyle(
  style: MarkdownStyleInternal
): CSSProperties {
  const taskList = style.taskList;
  return {
    color: taskList.checkedTextColor || undefined,
    textDecorationLine: taskList.checkedStrikethrough
      ? 'line-through'
      : undefined,
  };
}

/**
 * Checkbox style used when `enableTaskListItemToggle` is `false`. Pointer-inert
 * so the browser paints no hover/active state on a checkbox that cannot be
 * toggled; appearance is otherwise identical to the enabled checkbox.
 */
function taskCheckboxDisabledStyle(
  style: MarkdownStyleInternal
): CSSProperties {
  return {
    ...taskCheckboxStyle(style),
    pointerEvents: 'none',
    cursor: 'default',
  };
}

function taskCheckboxStyle(style: MarkdownStyleInternal): CSSProperties {
  const taskList = style.taskList;
  return {
    width: taskList.checkboxSize,
    height: taskList.checkboxSize,
    borderRadius: taskList.checkboxBorderRadius,
    marginInlineEnd: 6,
    accentColor: taskList.checkedColor,
    verticalAlign: 'middle',
  };
}

export function tableBodyRowStyle(
  style: MarkdownStyleInternal,
  rowIndex: number
): CSSProperties {
  const table = style.table;
  return {
    backgroundColor:
      rowIndex % 2 === 0
        ? table.rowEvenBackgroundColor
        : table.rowOddBackgroundColor,
  };
}

function tableWrapperStyle(style: MarkdownStyleInternal): CSSProperties {
  const table = style.table;
  const alignment: CSSProperties = table.align
    ? {
        width: 'fit-content',
        maxWidth: '100%',
        marginLeft: table.align === 'left' ? 0 : 'auto',
        marginRight: table.align === 'right' ? 0 : 'auto',
      }
    : {};
  return {
    overflowX: 'auto',
    overflowY: 'hidden',
    marginTop: table.marginTop,
    marginBottom: table.marginBottom,
    ...alignment,
    // borderRadius must live on the wrapper, not the <table> — border-collapse:
    // collapse causes browsers to ignore border-radius on the table element itself.
    borderRadius: table.borderRadius,
  };
}

function tableHeaderCellStyle(
  style: MarkdownStyleInternal,
  align: 'left' | 'center' | 'right' | 'default' | undefined
): CSSProperties {
  const table = style.table;
  return {
    backgroundColor: table.headerBackgroundColor,
    color: table.headerTextColor,
    fontFamily:
      normalizeFontFamily(table.headerFontFamily) ??
      normalizeFontFamily(table.fontFamily),
    fontWeight: 'bold',
    padding: `${table.cellPaddingVertical}px ${table.cellPaddingHorizontal}px`,
    border: `${table.borderWidth}px solid ${table.borderColor}`,
    textAlign: resolveColumnAlign(align),
  };
}

function tableCellStyle(
  style: MarkdownStyleInternal,
  align: 'left' | 'center' | 'right' | 'default' | undefined
): CSSProperties {
  const table = style.table;
  return {
    padding: `${table.cellPaddingVertical}px ${table.cellPaddingHorizontal}px`,
    border: `${table.borderWidth}px solid ${table.borderColor}`,
    textAlign: resolveColumnAlign(align),
  };
}

export const parseErrorFallbackStyle: CSSProperties = {
  whiteSpace: 'pre-wrap',
  margin: 0,
};

export interface Styles {
  paragraph: CSSProperties;
  paragraphInBlockquote: CSSProperties;
  h1: CSSProperties;
  h2: CSSProperties;
  h3: CSSProperties;
  h4: CSSProperties;
  h5: CSSProperties;
  h6: CSSProperties;
  blockquote: CSSProperties;
  list: CSSProperties;
  listNested: CSSProperties;
  listTask: CSSProperties;
  codeBlock: CSSProperties;
  codeBlockFont: CSSProperties;
  thematicBreak: CSSProperties;
  image: CSSProperties;
  inlineImage: CSSProperties;
  strong: CSSProperties;
  emphasis: CSSProperties;
  code: CSSProperties;
  link: CSSProperties;
  strikethrough: CSSProperties;
  underline: CSSProperties;
  superscript: CSSProperties;
  subscript: CSSProperties;
  highlight: CSSProperties;
  mathInline: CSSProperties;
  mathDisplay: CSSProperties;
  table: CSSProperties;
  tableWrapper: CSSProperties;
  tableHeaderCell: Record<ColumnAlign, CSSProperties>;
  tableCell: Record<ColumnAlign, CSSProperties>;
  taskCheckbox: CSSProperties;
  taskCheckboxDisabled: CSSProperties;
  video: CSSProperties;
}

type ColumnAlign = 'left' | 'center' | 'right' | 'default';

const stylesStore = new WeakMap<MarkdownStyleInternal, Styles>();

export function buildStyles(style: MarkdownStyleInternal): Styles {
  const cached = stylesStore.get(style);
  if (cached) return cached;

  const codeBlock = codeBlockStyle(style);
  const result: Styles = {
    paragraph: paragraphStyle(style),
    paragraphInBlockquote: paragraphInBlockquoteStyle(style),
    h1: headingStyle(style, '1'),
    h2: headingStyle(style, '2'),
    h3: headingStyle(style, '3'),
    h4: headingStyle(style, '4'),
    h5: headingStyle(style, '5'),
    h6: headingStyle(style, '6'),
    blockquote: blockquoteStyle(style),
    list: listStyle(style),
    listNested: {
      ...listStyle(style),
      // A nested list sits directly under its parent item's text; itemSpacing
      // (not the list's outer margins) controls that gap, like on native.
      marginTop: Math.max(0, style.list.itemSpacing),
      marginBottom: 0,
    },
    listTask: listStyle(style, true),
    codeBlock,
    codeBlockFont: { fontFamily: codeBlock.fontFamily },
    thematicBreak: thematicBreakStyle(style),
    image: imageStyle(style),
    inlineImage: inlineImageStyle(style),
    strong: strongStyle(style),
    emphasis: emphasisStyle(style),
    code: codeStyle(style),
    link: linkStyle(style),
    strikethrough: strikethroughStyle(style),
    underline: underlineStyle(style),
    superscript: superscriptStyle(style),
    subscript: subscriptStyle(style),
    highlight: highlightStyle(style),
    mathInline: mathInlineStyle(style),
    mathDisplay: mathDisplayStyle(style),
    table: tableStyle(style),
    tableWrapper: tableWrapperStyle(style),
    tableHeaderCell: {
      left: tableHeaderCellStyle(style, 'left'),
      center: tableHeaderCellStyle(style, 'center'),
      right: tableHeaderCellStyle(style, 'right'),
      default: tableHeaderCellStyle(style, 'default'),
    },
    tableCell: {
      left: tableCellStyle(style, 'left'),
      center: tableCellStyle(style, 'center'),
      right: tableCellStyle(style, 'right'),
      default: tableCellStyle(style, 'default'),
    },
    taskCheckbox: taskCheckboxStyle(style),
    taskCheckboxDisabled: taskCheckboxDisabledStyle(style),
    video: videoStyle(style),
  };

  stylesStore.set(style, result);
  return result;
}
