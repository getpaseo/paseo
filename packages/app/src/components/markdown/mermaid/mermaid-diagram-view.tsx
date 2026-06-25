import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import {
  buildMermaidThemeKey,
  buildMermaidThemeVariables,
} from "@/components/markdown/mermaid/mermaid-theme";
import { mermaidWebViewHtml } from "@/components/markdown/mermaid/mermaid-webview-html";

const MERMAID_WEBVIEW_SOURCE = { html: mermaidWebViewHtml };
const MERMAID_WEBVIEW_ORIGIN_WHITELIST = ["*"];
const MERMAID_RENDER_DEBOUNCE_MS = 250;
const MERMAID_WEBVIEW_MIN_HEIGHT = 48;

interface MermaidDiagramViewProps {
  source: string;
  onSvgChange?: (svg: string | null) => void;
}

interface WebViewOutboundMessage {
  type: "rendered" | "error";
  svg?: string;
  height?: number;
  message?: string;
}

export function MermaidDiagramView({ source, onSvgChange }: MermaidDiagramViewProps) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const themeVariables = buildMermaidThemeVariables(theme);
  const themeKey = buildMermaidThemeKey(themeVariables);
  const webViewRef = useRef<WebView>(null);
  const [height, setHeight] = useState(MERMAID_WEBVIEW_MIN_HEIGHT);
  const [error, setError] = useState<string | null>(null);
  const [isRendering, setIsRendering] = useState(false);
  const [svg, setSvg] = useState<string | null>(null);

  const postRender = useCallback(() => {
    const payload = JSON.stringify({
      type: "render",
      source,
      themeKey,
      themeVariables,
    });
    const script = `window.__paseoMermaidHandleMessage?.(${JSON.stringify(payload)}); true;`;
    webViewRef.current?.injectJavaScript(script);
  }, [source, themeKey, themeVariables]);

  useEffect(() => {
    const trimmed = source.trim();
    if (trimmed.length === 0) {
      setSvg(null);
      setError(null);
      setIsRendering(false);
      onSvgChange?.(null);
      return;
    }

    setIsRendering(true);
    setError(null);
    const timeout = setTimeout(() => {
      postRender();
    }, MERMAID_RENDER_DEBOUNCE_MS);

    return () => {
      clearTimeout(timeout);
    };
  }, [onSvgChange, postRender, source]);

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let parsed: WebViewOutboundMessage;
      try {
        parsed = JSON.parse(event.nativeEvent.data) as WebViewOutboundMessage;
      } catch {
        return;
      }

      if (parsed.type === "error") {
        setError(parsed.message ?? t("markdown.mermaid.renderFailed"));
        setSvg(null);
        setIsRendering(false);
        onSvgChange?.(null);
        return;
      }

      if (parsed.type === "rendered" && parsed.svg) {
        setSvg(parsed.svg);
        setError(null);
        setIsRendering(false);
        if (typeof parsed.height === "number" && parsed.height > 0) {
          setHeight(Math.ceil(parsed.height));
        }
        onSvgChange?.(parsed.svg);
      }
    },
    [onSvgChange, t],
  );

  const webViewStyle = useMemo(() => ({ width: "100%" as const, height }), [height]);

  if (error) {
    return (
      <View style={diagramStyles.errorWrap}>
        <Text style={diagramStyles.errorText}>{t("markdown.mermaid.renderFailed")}</Text>
      </View>
    );
  }

  return (
    <View style={diagramStyles.webviewWrap}>
      {isRendering && !svg ? (
        <View style={diagramStyles.spinnerOverlay}>
          <ActivityIndicator />
        </View>
      ) : null}
      <WebView
        ref={webViewRef}
        originWhitelist={MERMAID_WEBVIEW_ORIGIN_WHITELIST}
        source={MERMAID_WEBVIEW_SOURCE}
        onMessage={handleMessage}
        onLoadEnd={postRender}
        scrollEnabled={false}
        style={webViewStyle}
        javaScriptEnabled
        domStorageEnabled
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
      />
    </View>
  );
}

const diagramStyles = StyleSheet.create((theme) => ({
  webviewWrap: {
    width: "100%",
    minHeight: MERMAID_WEBVIEW_MIN_HEIGHT,
    overflow: "hidden",
  },
  spinnerOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1,
  },
  errorWrap: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
  },
}));
