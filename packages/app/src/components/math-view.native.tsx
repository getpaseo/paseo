import { useMemo, useState, useCallback } from "react";
import { Text, View } from "react-native";
import { useUnistyles } from "react-native-unistyles";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import katex from "katex";

export interface MathViewProps {
  expression: string;
  displayMode: boolean;
}

const KATEX_CSS_URL = "https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.css";

function buildHtml(katexHtml: string, textColor: string, displayMode: boolean): string {
  const align = displayMode ? "center" : "left";
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
    text-align: ${align};
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

export function MathView({ expression, displayMode }: MathViewProps) {
  const { theme } = useUnistyles();
  const [height, setHeight] = useState(displayMode ? 60 : 24);

  const katexHtml = useMemo(() => {
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

  const html = useMemo(() => {
    if (!katexHtml) return null;
    return buildHtml(katexHtml, theme.colors.foreground, displayMode);
  }, [katexHtml, theme.colors.foreground, displayMode]);

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
      <Text style={{ fontFamily: "monospace", color: theme.colors.destructive }}>{expression}</Text>
    );
  }

  return (
    <View
      style={
        displayMode
          ? { alignItems: "center", marginVertical: theme.spacing[2] }
          : { flexDirection: "row" }
      }
    >
      <WebView
        source={{ html }}
        style={{
          height,
          width: displayMode ? "100%" : undefined,
          backgroundColor: "transparent",
          minWidth: displayMode ? undefined : 40,
        }}
        scrollEnabled={false}
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
        onMessage={onMessage}
        originWhitelist={["*"]}
      />
    </View>
  );
}
