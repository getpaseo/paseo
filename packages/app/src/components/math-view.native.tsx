import { useMemo, useState, useCallback } from "react";
import { Text, View } from "react-native";
import { useUnistyles } from "react-native-unistyles";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { Fonts } from "@/constants/theme";
import katex from "katex";

export interface MathViewProps {
  expression: string;
  displayMode: boolean;
}

const KATEX_CSS_URL = "https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.css";

function buildHtml(katexHtml: string, textColor: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<link rel="stylesheet" href="${KATEX_CSS_URL}" crossorigin="anonymous">
<style>
  html, body {
    margin: 0;
    padding: 0;
    background: transparent;
    color: ${textColor};
    text-align: center;
  }
  .katex { font-size: 1.1em; }
</style>
</head>
<body>${katexHtml}<script>
  window.onload = function() {
    var h = document.body.scrollHeight;
    window.ReactNativeWebView.postMessage(JSON.stringify({ height: h }));
  };
</script></body>
</html>`;
}

/**
 * Native inline math: rendered as styled text since <View>/<WebView> cannot
 * be nested inside <Text> parents used by react-native-markdown-display.
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
 * Native block math: rendered via WebView with KaTeX for full display rendering.
 */
function BlockMath({ expression, theme }: { expression: string; theme: any }) {
  const [height, setHeight] = useState(60);

  const katexHtml = useMemo(() => {
    try {
      return katex.renderToString(expression, {
        displayMode: true,
        throwOnError: false,
        errorColor: theme.colors.destructive,
        trust: false,
        strict: "ignore",
      });
    } catch {
      return null;
    }
  }, [expression, theme.colors.destructive]);

  const html = useMemo(() => {
    if (!katexHtml) return null;
    return buildHtml(katexHtml, theme.colors.foreground);
  }, [katexHtml, theme.colors.foreground]);

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

  if (!html) {
    return (
      <Text style={{ fontFamily: Fonts.mono, color: theme.colors.destructive }}>{expression}</Text>
    );
  }

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
