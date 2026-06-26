import { useCallback, useMemo } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { WebView } from "react-native-webview";

export type MermaidDiagramHostLayout = "intrinsic" | "fill";

export interface MermaidDiagramHostProps {
  svg: string;
  style?: StyleProp<ViewStyle>;
  layout?: MermaidDiagramHostLayout;
}

const MERMAID_SVG_HOST_ORIGIN_WHITELIST = ["about:blank"];

function buildSvgHostHtml(svg: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <style>
      html, body, #root { width: 100%; height: 100%; margin: 0; padding: 0; background: transparent; overflow: hidden; }
      #root { display: flex; align-items: center; justify-content: center; }
      svg { max-width: 100%; max-height: 100%; width: auto; height: auto; display: block; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script>
      const root = document.getElementById("root");
      root.innerHTML = ${JSON.stringify(svg)};
      const svgElement = root.querySelector("svg");
      if (svgElement) {
        svgElement.removeAttribute("height");
      }
    </script>
  </body>
</html>`;
}

export function MermaidDiagramHost({ svg, style }: MermaidDiagramHostProps) {
  const source = useMemo(() => ({ html: buildSvgHostHtml(svg) }), [svg]);
  const hostStyle = useMemo(() => [nativeHostStyles.host, style], [style]);

  const handleShouldStartLoad = useCallback((request: { url: string }) => {
    const url = request.url;
    return url === "about:blank" || url.startsWith("data:") || url === "";
  }, []);

  return (
    <View testID="mermaid-diagram-host" style={hostStyle}>
      <WebView
        originWhitelist={MERMAID_SVG_HOST_ORIGIN_WHITELIST}
        source={source}
        onShouldStartLoadWithRequest={handleShouldStartLoad}
        scrollEnabled={false}
        style={nativeHostStyles.webview}
        javaScriptEnabled
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
      />
    </View>
  );
}

const nativeHostStyles = StyleSheet.create({
  host: {
    flex: 1,
    width: "100%",
    minHeight: 0,
    overflow: "hidden",
  },
  webview: {
    flex: 1,
    width: "100%",
    backgroundColor: "transparent",
  },
});
