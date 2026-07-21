import { useCallback, useEffect, useRef, useState } from "react";
import {
  Modal,
  Pressable,
  StyleSheet as RNStyleSheet,
  View,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import { mermaidWebViewHtml } from "@/components/mermaid-webview/mermaid-webview-html.gen";
import type { Theme } from "@/styles/theme";
import { containsUnsafeMermaidSource } from "@/utils/mermaid-fence";

export interface MermaidDiagramProps {
  code: string;
  inheritedStyles: TextStyle;
  textStyle: TextStyle;
}

interface MermaidDiagramImplProps extends MermaidDiagramProps {
  colorScheme?: "light" | "dark";
}

const WEBVIEW_SOURCE = { html: mermaidWebViewHtml };
const WEBVIEW_ORIGIN_WHITELIST = ["*"];
const MAX_PREVIEW_HEIGHT = 480;

interface BridgeRenderMessage {
  type: "render";
  requestId: number;
  code: string;
  colorScheme: "light" | "dark";
  interactive: boolean;
}

function serializeForInjectedJavaScript(message: BridgeRenderMessage): string {
  return JSON.stringify(message).replace(/<\/script/gi, "<\\/script");
}

interface MermaidWebViewProps {
  code: string;
  colorScheme: "light" | "dark";
  interactive: boolean;
  onRendered?: (height: number, renderedCode: string) => void;
  style?: ViewStyle;
}

/** Bridge wrapper around the generated mermaid webview HTML. */
function MermaidWebView({
  code,
  colorScheme,
  interactive,
  onRendered,
  style,
}: MermaidWebViewProps) {
  const webViewRef = useRef<WebView | null>(null);
  const bridgeReadyRef = useRef(false);
  const renderInputRef = useRef({ code, colorScheme, interactive });
  renderInputRef.current = { code, colorScheme, interactive };

  // Sources by request id, so a "rendered" event is credited to the source
  // that actually produced it — a newer (possibly invalid) chunk can be sent
  // while an older render's completion message is still in flight.
  const requestSeqRef = useRef(0);
  const sentSourcesRef = useRef(new Map<number, string>());

  const sendRender = useCallback(() => {
    if (!bridgeReadyRef.current || !webViewRef.current) return;
    requestSeqRef.current += 1;
    const requestId = requestSeqRef.current;
    sentSourcesRef.current.set(requestId, renderInputRef.current.code);
    const payload = serializeForInjectedJavaScript({
      type: "render",
      requestId,
      ...renderInputRef.current,
    });
    webViewRef.current.injectJavaScript(
      `window.__PASEO_MERMAID_WEBVIEW_RECEIVE__ && window.__PASEO_MERMAID_WEBVIEW_RECEIVE__(${payload}); true;`,
    );
  }, []);

  useEffect(() => {
    sendRender();
  }, [sendRender, code, colorScheme]);

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let message: { type?: string; height?: number; requestId?: number };
      try {
        message = JSON.parse(event.nativeEvent.data) as {
          type?: string;
          height?: number;
          requestId?: number;
        };
      } catch {
        return;
      }
      if (message.type === "bridgeReady") {
        bridgeReadyRef.current = true;
        sendRender();
        return;
      }
      if (
        message.type === "rendered" &&
        typeof message.height === "number" &&
        typeof message.requestId === "number"
      ) {
        const source = sentSourcesRef.current.get(message.requestId);
        // Resolved and older entries can never be credited again.
        for (const id of sentSourcesRef.current.keys()) {
          if (id <= message.requestId) sentSourcesRef.current.delete(id);
        }
        if (source !== undefined) onRendered?.(message.height, source);
        return;
      }
      if (message.type === "renderError" && typeof message.requestId === "number") {
        sentSourcesRef.current.delete(message.requestId);
      }
    },
    [onRendered, sendRender],
  );

  // The HTML is self-contained; block every navigation attempt.
  const handleShouldStartLoad = useCallback(
    (request: { url: string }) => request.url === "about:blank" || request.url.startsWith("data:"),
    [],
  );

  return (
    <WebView
      ref={webViewRef}
      source={WEBVIEW_SOURCE}
      originWhitelist={WEBVIEW_ORIGIN_WHITELIST}
      style={[webViewStyles.webView, style]}
      onMessage={handleMessage}
      onShouldStartLoadWithRequest={handleShouldStartLoad}
      scrollEnabled={interactive}
      bounces={false}
      scalesPageToFit={interactive}
      setSupportMultipleWindows={false}
      allowsLinkPreview={false}
      javaScriptEnabled
    />
  );
}

const webViewStyles = RNStyleSheet.create({
  webView: {
    backgroundColor: "transparent",
  },
});

interface MermaidDiagramViewerProps {
  code: string;
  colorScheme: "light" | "dark";
  onClose: () => void;
}

/** Fullscreen viewer; the platform webview owns pinch-zoom and panning. */
function MermaidDiagramViewer({ code, colorScheme, onClose }: MermaidDiagramViewerProps) {
  const { t } = useTranslation();
  return (
    <Modal transparent animationType="fade" statusBarTranslucent visible onRequestClose={onClose}>
      <View style={viewerStyles.backdrop}>
        <MermaidWebView
          code={code}
          colorScheme={colorScheme}
          interactive
          style={viewerStyles.webView}
        />
        <Pressable
          onPress={onClose}
          style={viewerStyles.closeButton}
          accessibilityRole="button"
          accessibilityLabel={t("common.actions.close")}
          hitSlop={12}
        >
          <ThemedCloseIcon size={20} uniProps={closeIconColor} />
        </Pressable>
      </View>
    </Modal>
  );
}

const ThemedCloseIcon = withUnistyles(X);
const closeIconColor = (theme: Theme) => ({ color: theme.colors.foreground });

const viewerStyles = StyleSheet.create((theme, rt) => ({
  backdrop: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  webView: {
    flex: 1,
    marginTop: rt.insets.top,
    marginBottom: rt.insets.bottom,
  },
  closeButton: {
    position: "absolute",
    top: rt.insets.top + theme.spacing[3],
    right: theme.spacing[4],
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
  },
}));

function MermaidDiagramImpl({
  code,
  inheritedStyles,
  textStyle,
  colorScheme = "dark",
}: MermaidDiagramImplProps) {
  // Last successful render: height sizes the preview, and its source (not the
  // possibly newer, still-invalid streamed code) is what the fullscreen viewer
  // renders — otherwise tapping mid-stream could open a blank viewer. Null
  // until the first valid parse (the code block shows meanwhile, matching web).
  const [lastGoodRender, setLastGoodRender] = useState<{ code: string; height: number } | null>(
    null,
  );
  const handleRendered = useCallback(
    (height: number, renderedCode: string) => setLastGoodRender({ code: renderedCode, height }),
    [],
  );
  const [viewerOpen, setViewerOpen] = useState(false);
  const openViewer = useCallback(() => setViewerOpen(true), []);
  const closeViewer = useCallback(() => setViewerOpen(false), []);

  if (containsUnsafeMermaidSource(code)) {
    return (
      <HighlightedCodeBlock
        code={code}
        language="mermaid"
        inheritedStyles={inheritedStyles}
        textStyle={textStyle}
      />
    );
  }

  const { fontFamily: _ff, fontSize: _fs, color: _c, lineHeight: _lh, ...boxStyle } = textStyle;
  return (
    <>
      {lastGoodRender === null && (
        <HighlightedCodeBlock
          code={code}
          language="mermaid"
          inheritedStyles={inheritedStyles}
          textStyle={textStyle}
        />
      )}
      <Pressable
        onPress={openViewer}
        disabled={lastGoodRender === null}
        accessibilityRole={lastGoodRender === null ? undefined : "imagebutton"}
        accessibilityLabel="Mermaid diagram"
        style={
          lastGoodRender === null
            ? previewStyles.measuring
            : [
                boxStyle as ViewStyle,
                { height: Math.min(lastGoodRender.height, MAX_PREVIEW_HEIGHT) },
                previewStyles.preview,
              ]
        }
      >
        <View style={previewStyles.webViewShield} pointerEvents="none">
          <MermaidWebView
            code={code}
            colorScheme={colorScheme}
            interactive={false}
            onRendered={handleRendered}
          />
        </View>
      </Pressable>
      {viewerOpen && lastGoodRender ? (
        <MermaidDiagramViewer
          code={lastGoodRender.code}
          colorScheme={colorScheme}
          onClose={closeViewer}
        />
      ) : null}
    </>
  );
}

const previewStyles = RNStyleSheet.create({
  // Mounted off-screen at full width so the svg lays out at its real size
  // while the code block is still showing.
  measuring: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 240,
    opacity: 0,
  },
  preview: {
    overflow: "hidden",
  },
  webViewShield: {
    flex: 1,
  },
});

const mapColorScheme = (theme: Theme) => ({ colorScheme: theme.colorScheme });

const ThemedMermaidDiagramImpl = withUnistyles(MermaidDiagramImpl);

export function MermaidDiagram(props: MermaidDiagramProps) {
  return <ThemedMermaidDiagramImpl {...props} uniProps={mapColorScheme} />;
}
