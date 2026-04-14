import { useMemo } from "react";
import { Text, View } from "react-native";
import { useUnistyles } from "react-native-unistyles";
import katex from "katex";

export interface MathViewProps {
  expression: string;
  displayMode: boolean;
}

let cssInjected = false;

function injectKatexCss() {
  if (cssInjected) return;
  if (typeof document === "undefined") return;

  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.css";
  link.crossOrigin = "anonymous";
  document.head.appendChild(link);
  cssInjected = true;
}

/**
 * Web implementation of MathView.
 *
 * Security: KaTeX's renderToString with `trust: false` produces only safe math
 * markup (spans with CSS classes). It does not pass through arbitrary HTML.
 * See https://katex.org/docs/options.html#trust
 */
export function MathView({ expression, displayMode }: MathViewProps) {
  const { theme } = useUnistyles();

  const html = useMemo(() => {
    injectKatexCss();
    try {
      return katex.renderToString(expression, {
        displayMode,
        throwOnError: false,
        errorColor: theme.colors.destructive,
        trust: false,
        strict: "ignore",
      });
    } catch {
      return null;
    }
  }, [expression, displayMode, theme.colors.destructive]);

  if (!html) {
    return (
      <Text style={{ fontFamily: "monospace", color: theme.colors.destructive }}>{expression}</Text>
    );
  }

  if (displayMode) {
    return (
      <View style={{ alignItems: "center", marginVertical: theme.spacing[2] }}>
        <div
          style={{ color: theme.colors.foreground, fontSize: theme.fontSize.base }}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX with trust:false only outputs safe math markup spans
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </View>
    );
  }

  return (
    <span
      style={{ color: theme.colors.foreground }}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX with trust:false only outputs safe math markup spans
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
