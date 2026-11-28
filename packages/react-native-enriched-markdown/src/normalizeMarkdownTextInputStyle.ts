import { processColor, type ColorValue } from 'react-native';
import type {
  HeadingStyle,
  LinkStyle,
  MarkdownTextInputStyle,
} from './EnrichedMarkdownTextInput';
import { normalizeLinkVariantEntries } from './linkVariantUtils';
import { normalizeColor } from './styleUtils';
import {
  DEFAULT_HEADING_FONT_WEIGHT,
  HEADING_DEFAULTS,
  type HeadingLevelKey,
} from './headingDefaults';

interface LinkVariantEntryInternal {
  pattern: string;
  color: ColorValue;
  underline: boolean;
  backgroundColor: ColorValue;
}

interface HeadingStyleInternal {
  fontSize: number;
  fontWeight: string;
  color: ColorValue;
}

interface MarkdownTextInputStyleInternal {
  strong: {
    color?: ColorValue;
  };
  em: {
    color?: ColorValue;
  };
  link: {
    color: ColorValue;
    underline: boolean;
    backgroundColor: ColorValue;
  };
  linkVariants: LinkVariantEntryInternal[];
  spoiler: {
    color: ColorValue;
    backgroundColor: ColorValue;
  };
  h1: HeadingStyleInternal;
  h2: HeadingStyleInternal;
  h3: HeadingStyleInternal;
  h4: HeadingStyleInternal;
  h5: HeadingStyleInternal;
  h6: HeadingStyleInternal;
  list: {
    itemSpacing: number;
  };
}

const DEFAULT_LINK_COLOR = '#2563EB';
const DEFAULT_LINK_BG_COLOR = 'transparent';
const DEFAULT_SPOILER_COLOR = '#374151';
const DEFAULT_SPOILER_BG_COLOR = '#E5E7EB';

// Defaults shared with the read-only renderer via headingDefaults; consumers
// override per level via markdownStyle h1..h6.
const defaultHeadingInternal = (key: HeadingLevelKey): HeadingStyleInternal => {
  const d = HEADING_DEFAULTS[key];
  return {
    fontSize: d.fontSize,
    fontWeight: DEFAULT_HEADING_FONT_WEIGHT,
    color: processColor(d.color)!,
  };
};

const defaultInternal: MarkdownTextInputStyleInternal = Object.freeze({
  strong: {
    color: undefined,
  },
  em: {
    color: undefined,
  },
  link: {
    color: processColor(DEFAULT_LINK_COLOR)!,
    underline: true,
    backgroundColor: processColor(DEFAULT_LINK_BG_COLOR)!,
  },
  linkVariants: [],
  spoiler: {
    color: processColor(DEFAULT_SPOILER_COLOR)!,
    backgroundColor: processColor(DEFAULT_SPOILER_BG_COLOR)!,
  },
  h1: defaultHeadingInternal('h1'),
  h2: defaultHeadingInternal('h2'),
  h3: defaultHeadingInternal('h3'),
  h4: defaultHeadingInternal('h4'),
  h5: defaultHeadingInternal('h5'),
  h6: defaultHeadingInternal('h6'),
  list: {
    itemSpacing: 0,
  },
});

const normalizeHeadingStyle = (
  key: HeadingLevelKey,
  style: HeadingStyle | undefined
): HeadingStyleInternal => {
  const fallback = defaultInternal[key];
  return {
    fontSize: style?.fontSize ?? fallback.fontSize,
    fontWeight: style?.fontWeight ?? fallback.fontWeight,
    color: normalizeColor(style?.color) ?? fallback.color,
  };
};

let cachedInput: MarkdownTextInputStyle | undefined;
let cachedResult: MarkdownTextInputStyleInternal | undefined;

function normalizeInputLinkStyle(
  style: LinkStyle | undefined,
  fallback: MarkdownTextInputStyleInternal['link']
): MarkdownTextInputStyleInternal['link'] {
  return {
    color: normalizeColor(style?.color) ?? fallback.color,
    underline: style?.underline ?? fallback.underline,
    backgroundColor:
      normalizeColor(style?.backgroundColor) ?? fallback.backgroundColor,
  };
}

export const normalizeMarkdownTextInputStyle = (
  style?: MarkdownTextInputStyle
): MarkdownTextInputStyleInternal => {
  if (!style || Object.keys(style).length === 0) {
    return defaultInternal;
  }

  if (style === cachedInput && cachedResult) {
    return cachedResult;
  }

  const linkBase = normalizeInputLinkStyle(style.link, defaultInternal.link);
  const result: MarkdownTextInputStyleInternal = {
    strong: {
      color: normalizeColor(style.strong?.color),
    },
    em: {
      color: normalizeColor(style.em?.color),
    },
    link: linkBase,
    linkVariants: normalizeLinkVariantEntries(style.linkVariants).map(
      ([pattern, override]) => ({
        pattern,
        color: normalizeColor(override.color) ?? linkBase.color,
        underline: override.underline ?? linkBase.underline,
        backgroundColor:
          normalizeColor(override.backgroundColor) ??
          defaultInternal.link.backgroundColor,
      })
    ),
    spoiler: {
      color:
        normalizeColor(style.spoiler?.color) ?? defaultInternal.spoiler.color,
      backgroundColor:
        normalizeColor(style.spoiler?.backgroundColor) ??
        defaultInternal.spoiler.backgroundColor,
    },
    h1: normalizeHeadingStyle('h1', style.h1),
    h2: normalizeHeadingStyle('h2', style.h2),
    h3: normalizeHeadingStyle('h3', style.h3),
    h4: normalizeHeadingStyle('h4', style.h4),
    h5: normalizeHeadingStyle('h5', style.h5),
    h6: normalizeHeadingStyle('h6', style.h6),
    list: {
      itemSpacing: style.list?.itemSpacing ?? defaultInternal.list.itemSpacing,
    },
  };

  cachedInput = style;
  cachedResult = result;
  return result;
};
