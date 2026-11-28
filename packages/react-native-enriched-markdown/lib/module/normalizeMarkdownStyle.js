"use strict";

import { Platform } from 'react-native';
import { isStyleEqual, normalizeColor, mergeSubStyle } from "./styleUtils.js";
import { normalizeLinkVariantEntries, normalizeLinkPillStyle } from "./linkVariantUtils.js";
import { resolveAdmonitionColors } from "./admonitionDefaults.js";
import { DEFAULT_HEADING_FONT_WEIGHT, HEADING_DEFAULTS } from "./headingDefaults.js";
const getSystemFont = () => Platform.select({
  ios: 'System',
  android: 'sans-serif',
  web: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  default: 'sans-serif'
});
const getMonospaceFont = () => Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  web: 'ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, Consolas, "DejaVu Sans Mono", monospace',
  default: 'monospace'
});
const defaultTextColor = normalizeColor('#1F2937');
const codeBlockTextColor = normalizeColor('#F3F4F6');

// GitHub-dark syntax palette (Primer prettylights), tuned for the dark code
// block background (#1F2937). It is the single source of truth for per-token
// code colors: native reads these resolved values and holds no default of its
// own. The four inheriting tokens resolve to the code block base color.
const DEFAULT_CODE_BLOCK_SYNTAX_COLORS = {
  keyword: normalizeColor('#FF7B72'),
  operatorColor: codeBlockTextColor,
  punctuation: codeBlockTextColor,
  string: normalizeColor('#A5D6FF'),
  number: normalizeColor('#79C0FF'),
  constant: normalizeColor('#79C0FF'),
  comment: normalizeColor('#8B949E'),
  function: normalizeColor('#D2A8FF'),
  type: normalizeColor('#FFA657'),
  variable: codeBlockTextColor,
  property: normalizeColor('#79C0FF'),
  tag: normalizeColor('#7EE787'),
  attribute: normalizeColor('#79C0FF'),
  embedded: codeBlockTextColor
};
const INHERIT_SYNTAX_TOKENS = new Set(['operatorColor', 'punctuation', 'variable', 'embedded']);

// The public API exposes `operator`, but the internal/native token is named
// `operatorColor` because `operator` is a reserved word in the generated C++
// struct. Map the public key onto the internal token when reading user input.
const PUBLIC_SYNTAX_TOKEN_KEYS = {
  operatorColor: 'operator'
};

// Explicit type annotation needed: Object.freeze breaks contextual typing, so
// TypeScript widens literal 'auto' to `string` instead of `BlockTextAlign`.
const baseHeader = {
  fontFamily: getSystemFont(),
  fontWeight: DEFAULT_HEADING_FONT_WEIGHT,
  marginTop: 0,
  marginBottom: 8,
  textAlign: 'auto'
};
const DEFAULT_NORMALIZED_STYLE = Object.freeze({
  paragraph: {
    fontSize: 16,
    fontFamily: getSystemFont(),
    fontWeight: '',
    color: defaultTextColor,
    lineHeight: Platform.select({
      ios: 24,
      android: 26,
      default: 26
    }),
    marginTop: 0,
    marginBottom: 16,
    textAlign: 'auto'
  },
  h1: {
    ...baseHeader,
    fontSize: HEADING_DEFAULTS.h1.fontSize,
    color: normalizeColor(HEADING_DEFAULTS.h1.color),
    lineHeight: Platform.select({
      ios: 36,
      android: 38,
      default: 38
    })
  },
  h2: {
    ...baseHeader,
    fontSize: HEADING_DEFAULTS.h2.fontSize,
    color: normalizeColor(HEADING_DEFAULTS.h2.color),
    lineHeight: Platform.select({
      ios: 30,
      android: 32,
      default: 32
    })
  },
  h3: {
    ...baseHeader,
    fontSize: HEADING_DEFAULTS.h3.fontSize,
    color: normalizeColor(HEADING_DEFAULTS.h3.color),
    lineHeight: Platform.select({
      ios: 26,
      android: 28,
      default: 28
    })
  },
  h4: {
    ...baseHeader,
    fontSize: HEADING_DEFAULTS.h4.fontSize,
    color: normalizeColor(HEADING_DEFAULTS.h4.color),
    lineHeight: Platform.select({
      ios: 24,
      android: 26,
      default: 26
    })
  },
  h5: {
    ...baseHeader,
    fontSize: HEADING_DEFAULTS.h5.fontSize,
    color: normalizeColor(HEADING_DEFAULTS.h5.color),
    lineHeight: Platform.select({
      ios: 22,
      android: 24,
      default: 24
    })
  },
  h6: {
    ...baseHeader,
    fontSize: HEADING_DEFAULTS.h6.fontSize,
    color: normalizeColor(HEADING_DEFAULTS.h6.color),
    lineHeight: Platform.select({
      ios: 20,
      android: 22,
      default: 22
    })
  },
  blockquote: {
    fontSize: 16,
    fontFamily: getSystemFont(),
    fontWeight: '',
    color: normalizeColor('#4B5563'),
    lineHeight: Platform.select({
      ios: 24,
      android: 26,
      default: 26
    }),
    marginTop: 0,
    marginBottom: 16,
    borderColor: normalizeColor('#D1D5DB'),
    borderWidth: 3,
    gapWidth: 16,
    backgroundColor: normalizeColor('#F9FAFB'),
    borderRadius: 0,
    padding: 0,
    admonitions: resolveAdmonitionColors(undefined)
  },
  list: {
    fontSize: 16,
    fontFamily: getSystemFont(),
    fontWeight: '',
    color: defaultTextColor,
    lineHeight: Platform.select({
      ios: 22,
      android: 26,
      default: 26
    }),
    marginTop: 0,
    marginBottom: 16,
    bulletColor: normalizeColor('#6B7280'),
    bulletSize: 6,
    markerMinWidth: 0,
    markerColor: normalizeColor('#6B7280'),
    markerFontWeight: '500',
    gapWidth: 12,
    marginLeft: 24,
    itemSpacing: 0
  },
  codeBlock: {
    fontSize: 14,
    fontFamily: getMonospaceFont(),
    fontWeight: '',
    color: codeBlockTextColor,
    lineHeight: Platform.select({
      ios: 20,
      android: 22,
      default: 22
    }),
    marginTop: 0,
    marginBottom: 16,
    backgroundColor: normalizeColor('#1F2937'),
    borderColor: normalizeColor('#374151'),
    borderRadius: 8,
    borderWidth: 1,
    padding: 16,
    syntaxColors: {
      ...DEFAULT_CODE_BLOCK_SYNTAX_COLORS
    }
  },
  link: {
    fontFamily: '',
    color: normalizeColor('#2563EB'),
    underline: true,
    backgroundColor: normalizeColor('transparent')
  },
  linkVariants: [],
  strong: {
    fontFamily: '',
    fontWeight: 'bold',
    color: undefined
  },
  em: {
    fontFamily: '',
    fontStyle: 'italic',
    color: undefined
  },
  strikethrough: {
    color: normalizeColor('#9CA3AF')
  },
  underline: {
    color: defaultTextColor
  },
  code: {
    // Native uses '' (inherit); web needs an explicit monospace stack so inline
    // code doesn't fall back to the browser's default proportional font.
    fontFamily: Platform.select({
      web: getMonospaceFont(),
      default: ''
    }),
    fontSize: 0,
    fontScale: 1,
    color: normalizeColor('#E01E5A'),
    backgroundColor: normalizeColor('#FDF2F4'),
    borderColor: normalizeColor('#F8D7DA')
  },
  image: {
    height: 200,
    maxHeight: 0,
    aspectRatio: 0,
    resizeMode: '',
    borderRadius: 8,
    marginTop: 0,
    marginBottom: 16
  },
  video: {
    marginTop: 0,
    marginBottom: 16,
    borderRadius: 8,
    aspectRatio: 16 / 9,
    backgroundColor: normalizeColor('#000000')
  },
  inlineImage: {
    size: 20
  },
  thematicBreak: {
    color: normalizeColor('#E5E7EB'),
    height: 1,
    marginTop: 24,
    marginBottom: 24
  },
  table: {
    fontSize: 14,
    fontFamily: getSystemFont(),
    fontWeight: '',
    color: defaultTextColor,
    marginTop: 0,
    marginBottom: 16,
    lineHeight: Platform.select({
      ios: 20,
      android: 22,
      default: 22
    }),
    headerFontFamily: '',
    headerBackgroundColor: normalizeColor('#F3F4F6'),
    headerTextColor: normalizeColor('#111827'),
    rowEvenBackgroundColor: normalizeColor('#FFFFFF'),
    rowOddBackgroundColor: normalizeColor('#F9FAFB'),
    borderColor: normalizeColor('#E5E7EB'),
    borderWidth: 1,
    borderRadius: 6,
    cellPaddingHorizontal: 12,
    cellPaddingVertical: 8,
    horizontalOverflow: 0,
    align: ''
  },
  math: {
    fontSize: 20,
    color: defaultTextColor,
    backgroundColor: normalizeColor('#F3F4F6'),
    padding: 12,
    marginTop: 0,
    marginBottom: 16,
    textAlign: 'center'
  },
  inlineMath: {
    color: defaultTextColor
  },
  taskList: {
    checkedColor: Platform.select({
      ios: normalizeColor('#007AFF'),
      android: normalizeColor('#2196F3'),
      default: normalizeColor('#007AFF')
    }),
    borderColor: normalizeColor('#9E9E9E'),
    checkboxSize: 14,
    checkboxBorderRadius: 3,
    checkmarkColor: normalizeColor('#FFFFFF'),
    checkedTextColor: normalizeColor('#000000'),
    checkedStrikethrough: false
  },
  spoiler: {
    color: normalizeColor('#374151'),
    particles: {
      density: 8,
      speed: 20
    },
    solid: {
      borderRadius: 4
    }
  },
  superscript: {
    fontScale: Platform.select({
      android: 0.65,
      default: 0.75
    }),
    baselineOffsetScale: 0.35
  },
  subscript: {
    fontScale: Platform.select({
      android: 0.65,
      default: 0.75
    }),
    baselineOffsetScale: 0.2
  },
  highlight: {
    color: defaultTextColor,
    backgroundColor: normalizeColor('#FEF08A')
  }
});
const refCache = new WeakMap();
const structuralCache = [];
const LRU_MAX = 8;
const styleReferenceKeys = Object.keys(DEFAULT_NORMALIZED_STYLE);
export const normalizeMarkdownStyle = style => {
  if (!style || Object.keys(style).length === 0) return DEFAULT_NORMALIZED_STYLE;
  const refHit = refCache.get(style);
  if (refHit) return refHit;
  const structIdx = structuralCache.findIndex(e => isStyleEqual(e.style, style, styleReferenceKeys));
  if (structIdx !== -1) {
    const entry = structuralCache.splice(structIdx, 1)[0];
    structuralCache.unshift(entry);
    refCache.set(style, entry.result);
    return entry.result;
  }
  const result = {};
  Object.keys(DEFAULT_NORMALIZED_STYLE).forEach(key => {
    if (Array.isArray(DEFAULT_NORMALIZED_STYLE[key])) return;
    const userValue = style[key];
    result[key] = mergeSubStyle(DEFAULT_NORMALIZED_STYLE[key], userValue);
  });

  // Normalize variants longest-pattern-first so specific patterns win.
  const transparent = normalizeColor('transparent');
  const linkBase = result.link;
  result.linkVariants = normalizeLinkVariantEntries(style.linkVariants).map(([pattern, override]) => {
    const pill = normalizeLinkPillStyle(override);
    return {
      pattern,
      pill: {
        ...pill,
        iconTintColor: normalizeColor(pill.iconTintColor),
        borderColor: normalizeColor(pill.borderColor) ?? transparent
      },
      fontFamily: override.fontFamily ?? linkBase.fontFamily,
      color: (override.color ? normalizeColor(override.color) : null) ?? linkBase.color,
      underline: override.underline ?? linkBase.underline,
      backgroundColor: override.backgroundColor ? normalizeColor(override.backgroundColor) ?? transparent : transparent
    };
  });
  if (style.taskList?.checkboxSize === undefined) {
    const listSize = result.list.fontSize;
    result.taskList.checkboxSize = Math.round(listSize * 0.9);
  }

  // maxHeight/aspectRatio sizing is resize-mode driven; default to 'cover'.
  const image = result.image;
  if (!image.resizeMode && (image.maxHeight > 0 || image.aspectRatio > 0)) {
    result.image.resizeMode = 'cover';
  }
  if (!style.highlight?.color) {
    const paragraphColor = result.paragraph.color;
    result.highlight.color = paragraphColor;
  }

  // Admonition colors are nested two levels deep (blockquote.admonitions.<type>),
  // deeper than mergeSubStyle merges, so resolve the full per-type palette here.
  result.blockquote.admonitions = resolveAdmonitionColors(style.blockquote?.admonitions);
  const codeBlock = result.codeBlock;
  const userSyntaxColors = style.codeBlock?.syntaxColors;
  const resolvedSyntaxColors = {};
  for (const token in DEFAULT_CODE_BLOCK_SYNTAX_COLORS) {
    const publicKey = PUBLIC_SYNTAX_TOKEN_KEYS[token] ?? token;
    const userValue = userSyntaxColors?.[publicKey];
    if (typeof userValue === 'string') {
      resolvedSyntaxColors[token] = normalizeColor(userValue) ?? DEFAULT_CODE_BLOCK_SYNTAX_COLORS[token];
    } else if (INHERIT_SYNTAX_TOKENS.has(token)) {
      resolvedSyntaxColors[token] = codeBlock.color;
    } else {
      resolvedSyntaxColors[token] = DEFAULT_CODE_BLOCK_SYNTAX_COLORS[token];
    }
  }
  codeBlock.syntaxColors = resolvedSyntaxColors;
  const finalResult = Object.freeze(result);
  refCache.set(style, finalResult);
  structuralCache.unshift({
    style,
    result: finalResult
  });
  if (structuralCache.length > LRU_MAX) structuralCache.pop();
  return finalResult;
};
//# sourceMappingURL=normalizeMarkdownStyle.js.map