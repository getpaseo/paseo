import React, { useMemo, type CSSProperties } from "react";
import { ParseError, renderToString } from "katex";
import "katex/dist/katex.min.css";
import type { StyleProp, TextStyle } from "react-native";
const DISPLAY_STYLE: CSSProperties = {
  display: "block",
  maxWidth: "100%",
  overflowX: "auto",
  overflowY: "hidden",
};
const INLINE_STYLE: CSSProperties = {
  display: "inline-block",
  maxWidth: "100%",
  fontSize: "0.9em",
  verticalAlign: "baseline",
};

export interface MathFormulaProps {
  expression: string;
  source: string;
  displayMode: boolean;
  textStyle?: StyleProp<TextStyle>;
}

export function MathFormula({ expression, source, displayMode }: MathFormulaProps) {
  const rendered = useMemo(() => {
    const compactExpression = displayMode
      ? expression
      : expression.replace(/^\\displaystyle\s*/, "");
    try {
      const html = renderToString(compactExpression, {
        displayMode,
        output: "htmlAndMathml",
        throwOnError: false,
        trust: false,
      });
      return { __html: html };
    } catch (error) {
      if (error instanceof ParseError) {
        return null;
      }
      throw error;
    }
  }, [displayMode, expression]);

  if (!rendered) {
    return <code>{source}</code>;
  }

  if (displayMode) {
    return (
      <span
        aria-label={source}
        style={DISPLAY_STYLE}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX emits sanitized markup with trust disabled.
        dangerouslySetInnerHTML={rendered}
      />
    );
  }

  return (
    <span
      aria-label={source}
      style={INLINE_STYLE}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX emits sanitized markup with trust disabled.
      dangerouslySetInnerHTML={rendered}
    />
  );
}
