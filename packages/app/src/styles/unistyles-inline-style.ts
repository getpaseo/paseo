const UNISTYLES_INLINE_STYLE_KEY = "unistyles_inline_style";

/**
 * Forces a style object through Unistyles' inline/animated-style lane.
 *
 * Unistyles web sends ordinary style objects to the CSS registry. Styles that
 * look like animated styles stay in React Native's style array instead. Use
 * this only for high-churn values, such as measured dimensions, drag
 * transforms, and pressed/hovered state.
 */
export function inlineUnistylesStyle<TStyle extends object>(style: TStyle): TStyle {
  if (!Object.isExtensible(style) || UNISTYLES_INLINE_STYLE_KEY in style) {
    return style;
  }

  Object.defineProperty(style, UNISTYLES_INLINE_STYLE_KEY, {
    value: {},
    enumerable: true,
    configurable: true,
  });

  return style;
}
