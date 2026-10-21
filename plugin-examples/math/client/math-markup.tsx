import { renderToString } from "katex";
import { useMemo } from "react";
import { Platform, Text } from "react-native";
import type { MathMarkupProps } from "./math-markup-props";
import { WebMathMarkup } from "./web";

/**
 * Math markup.
 *
 * KaTeX runs with `output: "mathml"`, which needs no stylesheet and no web
 * fonts: the browser lays the MathML out itself. That keeps the plugin free of
 * a CSS asset pipeline, which plugins do not have. KaTeX is a plain JavaScript
 * dependency, so the plugin compiler bundles it into the client bundle.
 *
 * `throwOnError` is on deliberately. The segmenter hands over any `$...$` pair
 * it accepted, and a sentence can still fail to parse as TeX; returning null
 * prints the source instead of a red error span. `trust: false` keeps `\href`
 * and `\includegraphics` disabled, since assistant text is untrusted.
 *
 * iOS and Android have no MathML renderer, so they keep the delimited source.
 */
export function renderMathMarkup(tex: string, display: boolean): string | null {
  try {
    return renderToString(tex, {
      displayMode: display,
      throwOnError: true,
      strict: false,
      trust: false,
      output: "mathml",
    });
  } catch {
    return null;
  }
}

export function MathMarkup({ markup, source, display, color }: MathMarkupProps) {
  const textStyle = useMemo(() => ({ color }), [color]);
  if (Platform.OS !== "web" || markup === null) {
    return <Text style={textStyle}>{source}</Text>;
  }
  return <WebMathMarkup markup={markup} source={source} display={display} color={color} />;
}
