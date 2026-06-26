import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import type { MermaidThemeConfig } from "@/components/markdown/mermaid/mermaid-theme-config";
import { useMermaidThemeVariablesRef } from "@/components/markdown/mermaid/use-mermaid-theme-variables-ref";
import { mermaidWebViewHtml } from "@/components/markdown/mermaid/mermaid-webview-html";

const MERMAID_WEBVIEW_SOURCE = { html: mermaidWebViewHtml };
const MERMAID_WEBVIEW_ORIGIN_WHITELIST = ["about:blank"];
const MERMAID_RENDER_DEBOUNCE_MS = 250;
const MERMAID_WEBVIEW_MIN_HEIGHT = 48;

export interface MermaidDiagramViewInnerProps {
  source: string;
  mermaidTheme: MermaidThemeConfig;
  onSvgChange?: (svg: string | null) => void;
}

interface WebViewOutboundMessage {
  type: "rendered" | "error";
  requestId?: number;
  svg?: string;
  height?: number;
  message?: string;
}

export function MermaidDiagramViewInner({
  source,
  mermaidTheme,
  onSvgChange,
}: MermaidDiagramViewInnerProps) {
  const { t } = useTranslation();
  const { themeKey, themeVariablesRef } = useMermaidThemeVariablesRef(mermaidTheme);
  const webViewRef = useRef<WebView>(null);
  const requestIdRef = useRef(0);
  const [height, setHeight] = useState(MERMAID_WEBVIEW_MIN_HEIGHT);
  const [error, setError] = useState<string | null>(null);
  const [isRendering, setIsRendering] = useState(false);
  const [svg, setSvg] = useState<string | null>(null);

  const postRender = useCallback(() => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const payload = JSON.stringify({
      type: "render",
      requestId,
      source,
      themeKey,
      themeVariables: themeVariablesRef.current,
    });
    const script = `window.__paseoMermaidHandleMessage?.(${JSON.stringify(payload)}); true;`;
    webViewRef.current?.injectJavaScript(script);
  }, [source, themeKey, themeVariablesRef]);

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

      if (typeof parsed.requestId === "number" && parsed.requestId !== requestIdRef.current) {
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

  const handleShouldStartLoad = useCallback((request: { url: string }) => {
    const url = request.url;
    return url === "about:blank" || url.startsWith("data:") || url === "";
  }, []);

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
        onShouldStartLoadWithRequest={handleShouldStartLoad}
        scrollEnabled={false}
        style={webViewStyle}
        javaScriptEnabled
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
