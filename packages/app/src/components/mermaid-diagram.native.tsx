import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Modal,
  Pressable,
  StyleSheet as RNStyleSheet,
  ScrollView,
  View,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { Code, Network, X } from "lucide-react-native";
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
        // Serialization is latest-wins: requests skipped before this one can
        // never complete later, so prune them too or a long broken stream
        // retains every superseded source.
        for (const id of sentSourcesRef.current.keys()) {
          if (id <= message.requestId) sentSourcesRef.current.delete(id);
        }
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
  inheritedStyles: TextStyle;
  textStyle: TextStyle;
}

/** Fullscreen viewer; the platform webview owns pinch-zoom and panning. */
function MermaidDiagramViewer({
  code,
  colorScheme,
  onClose,
  inheritedStyles,
  textStyle,
}: MermaidDiagramViewerProps) {
  const { t } = useTranslation();
  const [showSource, setShowSource] = useState(false);
  const toggleSource = useCallback(() => setShowSource((current) => !current), []);
  return (
    <Modal transparent animationType="fade" statusBarTranslucent visible onRequestClose={onClose}>
      <View style={viewerStyles.backdrop}>
        {showSource ? (
          <ScrollView style={viewerStyles.webView} contentContainerStyle={viewerStyles.source}>
            <HighlightedCodeBlock
              code={code}
              language="mermaid"
              inheritedStyles={inheritedStyles}
              textStyle={textStyle}
            />
          </ScrollView>
        ) : (
          <MermaidWebView
            code={code}
            colorScheme={colorScheme}
            interactive
            style={viewerStyles.webView}
          />
        )}
        <View style={viewerStyles.actions}>
          <Pressable
            onPress={toggleSource}
            style={viewerStyles.actionButton}
            accessibilityRole="button"
            accessibilityLabel={
              showSource ? t("message.mermaid.viewDiagram") : t("message.mermaid.viewSource")
            }
            hitSlop={12}
          >
            {showSource ? (
              <ThemedDiagramIcon size={20} uniProps={closeIconColor} />
            ) : (
              <ThemedSourceIcon size={20} uniProps={closeIconColor} />
            )}
          </Pressable>
          <Pressable
            onPress={onClose}
            style={viewerStyles.actionButton}
            accessibilityRole="button"
            accessibilityLabel={t("common.actions.close")}
            hitSlop={12}
          >
            <ThemedCloseIcon size={20} uniProps={closeIconColor} />
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const ThemedCloseIcon = withUnistyles(X);
const ThemedSourceIcon = withUnistyles(Code);
const ThemedDiagramIcon = withUnistyles(Network);
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
  source: {
    // Layout-only: leave room for the floating action buttons.
    paddingTop: theme.spacing[12],
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
  actions: {
    position: "absolute",
    top: rt.insets.top + theme.spacing[3],
    right: theme.spacing[4],
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  actionButton: {
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
  const { t } = useTranslation();
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
  const previewInnerStyle = useMemo(
    () =>
      lastGoodRender === null
        ? previewStyles.measuringInner
        : { height: Math.min(lastGoodRender.height, MAX_PREVIEW_HEIGHT) },
    [lastGoodRender],
  );

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
        accessibilityLabel={t("message.mermaid.diagram")}
        style={
          lastGoodRender === null
            ? [boxStyle as ViewStyle, previewStyles.measuring]
            : [boxStyle as ViewStyle, previewStyles.preview]
        }
      >
        <View style={previewInnerStyle} pointerEvents="none">
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
          inheritedStyles={inheritedStyles}
          textStyle={textStyle}
        />
      ) : null}
    </>
  );
}

const previewStyles = RNStyleSheet.create({
  // Invisible overlay while the code block still shows underneath. Keeps the
  // fence box insets so the webview measures at the same content width the
  // final preview will have, and stays hit-test transparent so the code
  // block's copy button and gestures aren't blocked by an unrendered diagram.
  measuring: {
    position: "absolute",
    left: 0,
    right: 0,
    opacity: 0,
    pointerEvents: "none",
  },
  measuringInner: {
    height: 240,
  },
  // Height goes on the inner content view; the fence padding/border from
  // boxStyle then add onto it, so the reported SVG height is never eaten by
  // the insets.
  preview: {
    overflow: "hidden",
  },
});

const mapColorScheme = (theme: Theme) => ({ colorScheme: theme.colorScheme });

const ThemedMermaidDiagramImpl = withUnistyles(MermaidDiagramImpl);

export function MermaidDiagram(props: MermaidDiagramProps) {
  return <ThemedMermaidDiagramImpl {...props} uniProps={mapColorScheme} />;
}
