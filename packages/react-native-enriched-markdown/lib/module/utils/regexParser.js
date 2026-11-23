"use strict";

const DISABLED_REGEX = {
  pattern: '',
  caseInsensitive: false,
  dotAll: false,
  isDisabled: true,
  isDefault: false
};
const DEFAULT_REGEX = {
  pattern: '',
  caseInsensitive: false,
  dotAll: false,
  isDisabled: false,
  isDefault: true
};
export const toNativeRegexConfig = regex => {
  if (regex === null) {
    return DISABLED_REGEX;
  }
  if (regex === undefined) {
    return DEFAULT_REGEX;
  }
  const source = regex.source;
  const hasLookbehind = source.includes('(?<=') || source.includes('(?<!');
  if (hasLookbehind) {
    const lookbehindContent = source.match(/\(\?<[=!](.*?)\)/)?.[1] || '';
    if (/[*+{]/.test(lookbehindContent)) {
      if (__DEV__) {
        console.error('Variable-width lookbehinds are not supported. Using default link regex.');
      }
      return DEFAULT_REGEX;
    }
  }
  return {
    pattern: source,
    caseInsensitive: regex.ignoreCase,
    dotAll: regex.dotAll,
    isDisabled: false,
    isDefault: false
  };
};

/** Renderer recognition is opt-in, including when input normalization falls back. */
export const toNativeTextLinkRegexConfig = regex => {
  const config = toNativeRegexConfig(regex ?? null);
  return config.isDefault ? DISABLED_REGEX : config;
};
export const toNativeLinkRecognition = config => ({
  text: toNativeTextLinkRegexConfig(config?.text),
  inlineCode: toNativeTextLinkRegexConfig(config?.inlineCode)
});
const isNativeRegexEqual = (previous, next) => previous.pattern === next.pattern && previous.caseInsensitive === next.caseInsensitive && previous.dotAll === next.dotAll && previous.isDisabled === next.isDisabled && previous.isDefault === next.isDefault;
export const isLinkRecognitionEqual = (previous, next) => previous !== undefined && isNativeRegexEqual(previous.text, next.text) && isNativeRegexEqual(previous.inlineCode, next.inlineCode);
//# sourceMappingURL=regexParser.js.map