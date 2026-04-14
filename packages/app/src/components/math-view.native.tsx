import { useMemo, useState, useCallback } from "react";
import { Text, View } from "react-native";
import { useUnistyles } from "react-native-unistyles";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { Fonts } from "@/constants/theme";

export interface MathViewProps {
  expression: string;
  displayMode: boolean;
}

const KATEX_CSS = "https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.css";
const KATEX_JS = "https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.js";

/**
 * Build an HTML page that loads KaTeX inside the WebView and renders there.
 * This avoids calling katex.renderToString() in Hermes, which is unreliable.
 */
function buildHtml(expression: string, textColor: string, displayMode: boolean): string {
  // Escape the expression for safe embedding in a JS string literal
  const escaped = expression.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");
  return `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<link rel="stylesheet" href="${KATEX_CSS}" crossorigin="anonymous">
<script src="${KATEX_JS}" crossorigin="anonymous"><\/script>
<style>
  html, body {
    margin: 0;
    padding: ${displayMode ? "4px 0" : "0"};
    background: transparent;
    color: ${textColor};
    text-align: ${displayMode ? "center" : "left"};
    overflow: hidden;
  }
  .katex { font-size: 1.1em; }
  .katex-error { color: ${textColor}; font-family: monospace; font-size: 14px; }
</style>
</head>
<body>
<div id="math"></div>
<script>
  try {
    katex.render(\`${escaped}\`, document.getElementById("math"), {
      displayMode: ${displayMode},
      throwOnError: false,
      trust: false,
      strict: "ignore"
    });
  } catch(e) {
    document.getElementById("math").textContent = \`${escaped}\`;
  }
  // Report height after fonts/CSS load
  function postHeight() {
    var h = document.getElementById("math").offsetHeight;
    if (h > 0) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ height: h + ${displayMode ? 8 : 0} }));
    }
  }
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(postHeight);
  } else {
    window.onload = postHeight;
  }
  // Fallback in case fonts.ready doesn't fire
  setTimeout(postHeight, 1000);
<\/script>
</body>
</html>`;
}

/**
 * Native inline math: rendered as styled text since WebView cannot be nested
 * inside <Text> parents used by react-native-markdown-display.
 */
function InlineMath({ expression, theme }: { expression: string; theme: any }) {
  return (
    <Text
      style={{
        fontFamily: Fonts.mono,
        fontSize: theme.fontSize.sm,
        color: theme.colors.foreground,
      }}
    >
      {expression}
    </Text>
  );
}

/**
 * Native block math: KaTeX is loaded and rendered entirely inside the WebView
 * (not in Hermes) for reliable rendering.
 */
function BlockMath({ expression, theme }: { expression: string; theme: any }) {
  const [height, setHeight] = useState(60);

  const html = useMemo(
    () => buildHtml(expression, theme.colors.foreground, true),
    [expression, theme.colors.foreground],
  );

  const onMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (typeof data.height === "number" && data.height > 0) {
        setHeight(data.height);
      }
    } catch {
      // ignore malformed messages
    }
  }, []);

  return (
    <View style={{ alignItems: "center", marginVertical: theme.spacing[2] }}>
      <WebView
        source={{ html }}
        style={{ height, width: "100%", backgroundColor: "transparent" }}
        scrollEnabled={false}
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
        onMessage={onMessage}
        originWhitelist={["*"]}
        opaque={false}
        androidLayerType="software"
      />
    </View>
  );
}

export function MathView({ expression, displayMode }: MathViewProps) {
  const { theme } = useUnistyles();

  if (displayMode) {
    return <BlockMath expression={expression} theme={theme} />;
  }

  return <InlineMath expression={expression} theme={theme} />;
}
