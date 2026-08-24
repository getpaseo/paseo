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
import { Code, Workflow, X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import type { Theme } from "@/styles/theme";
import type { MarkdownFenceRendererProps } from "../types";
import type { MermaidRenderRequest } from "./render-model";
import { mermaidRuntimeHtml } from "./runtime/html.gen";
import {
  parseMermaidRuntimeMessage,
  serializeMermaidRuntimeRenderMessage,
  type MermaidRuntimeRenderMessage,
} from "./runtime/messages";
import { MermaidRuntimeRequestDriver } from "./runtime/request-driver";
import { useMermaidRenderModel } from "./use-render-model";
import { getDiagramBoxStyle } from "./presentation";

interface MermaidFenceHostImplProps extends MarkdownFenceRendererProps {
  colorScheme?: "light" | "dark";
}

const WEBVIEW_SOURCE = { html: mermaidRuntimeHtml };
const WEBVIEW_ORIGIN_WHITELIST = ["*"];
const MAX_PREVIEW_HEIGHT = 480;

interface MermaidWebViewProps {
  request: MermaidRenderRequest | null;
  interactive: boolean;
  onRendered: (message: {
    revision: number;
    source: string;
    colorScheme: "light" | "dark";
    height: number;
    width: number;
  }) => void;
  onRenderFailed: (revision: number) => void;
  style?: ViewStyle;
}

function MermaidWebView({
  request,
  interactive,
  onRendered,
  onRenderFailed,
  style,
}: MermaidWebViewProps) {
  const webViewRef = useRef<WebView | null>(null);
  const driverRef = useRef<MermaidRuntimeRequestDriver | null>(null);
  driverRef.current ??= new MermaidRuntimeRequestDriver();

  const sendRequest = useCallback(
    (current: MermaidRenderRequest | null) => {
      if (!current || !webViewRef.current) {
        return;
      }
      const message: MermaidRuntimeRenderMessage = {
        type: "render",
        revision: current.revision,
        source: current.source,
        colorScheme: current.colorScheme,
        interactive,
      };
      const payload = serializeMermaidRuntimeRenderMessage(message);
      webViewRef.current.injectJavaScript(
        `window.__PASEO_MERMAID_RUNTIME_RECEIVE__ && window.__PASEO_MERMAID_RUNTIME_RECEIVE__(${payload}); true;`,
      );
    },
    [interactive],
  );

  useEffect(() => {
    sendRequest(driverRef.current?.update(request) ?? null);
  }, [request, sendRequest]);

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let value: unknown;
      try {
        value = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }
      const message = parseMermaidRuntimeMessage(value);
      if (!message) {
        return;
      }
      if (message.type === "bridgeReady") {
        sendRequest(driverRef.current?.ready() ?? null);
        return;
      }
      if (message.type === "renderError") {
        onRenderFailed(message.revision);
        sendRequest(driverRef.current?.settled(message.revision, false) ?? null);
        return;
      }
      onRendered(message);
      sendRequest(driverRef.current?.settled(message.revision, true) ?? null);
    },
    [onRenderFailed, onRendered, sendRequest],
  );
  const handleShouldStartLoad = useCallback(
    (load: { url: string }) => load.url === "about:blank" || load.url.startsWith("data:"),
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
  webView: { backgroundColor: "transparent" },
});

interface MermaidDiagramViewerProps {
  code: string;
  colorScheme: "light" | "dark";
  onClose: () => void;
  inheritedStyles: TextStyle;
  textStyle: TextStyle;
}

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
  const { request, rendered, renderFailed } = useMermaidRenderModel({
    source: code,
    phase: "complete",
    colorScheme,
  });
  const handleRendered = useCallback(
    (message: {
      revision: number;
      source: string;
      colorScheme: "light" | "dark";
      height: number;
      width: number;
    }) => {
      rendered({
        revision: message.revision,
        source: message.source,
        colorScheme: message.colorScheme,
        dimensions: { height: message.height, width: message.width },
      });
    },
    [rendered],
  );

  return (
    <Modal transparent animationType="fade" statusBarTranslucent visible onRequestClose={onClose}>
      <View style={viewerStyles.backdrop}>
        <View style={viewerStyles.webView}>
          <MermaidWebView
            request={request}
            interactive
            onRendered={handleRendered}
            onRenderFailed={renderFailed}
            style={viewerStyles.runtime}
          />
          {showSource ? (
            <ScrollView
              style={viewerStyles.sourceOverlay}
              contentContainerStyle={viewerStyles.source}
            >
              <HighlightedCodeBlock
                code={code}
                language="mermaid"
                inheritedStyles={inheritedStyles}
                textStyle={textStyle}
              />
            </ScrollView>
          ) : null}
        </View>
        <View style={viewerStyles.actions}>
          <Pressable
            onPress={toggleSource}
            style={viewerStyles.actionButton}
            accessibilityRole="button"
            accessibilityLabel={
              showSource ? t("message.diagram.viewDiagram") : t("message.diagram.viewSource")
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
const ThemedDiagramIcon = withUnistyles(Workflow);
const closeIconColor = (theme: Theme) => ({ color: theme.colors.foreground });

const viewerStyles = StyleSheet.create((theme, runtime) => ({
  backdrop: { flex: 1, backgroundColor: theme.colors.surface0 },
  webView: {
    flex: 1,
    marginTop: runtime.insets.top,
    marginBottom: runtime.insets.bottom,
  },
  runtime: { flex: 1 },
  sourceOverlay: {
    position: "absolute",
    inset: 0,
    backgroundColor: theme.colors.surface0,
  },
  source: {
    paddingTop: theme.spacing[12],
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
  actions: {
    position: "absolute",
    top: runtime.insets.top + theme.spacing[3],
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

function MermaidFenceHostImpl({
  code,
  phase,
  inheritedStyles,
  textStyle,
  colorScheme = "dark",
}: MermaidFenceHostImplProps) {
  const { t } = useTranslation();
  const { state, request, rendered, renderFailed } = useMermaidRenderModel({
    source: code,
    phase,
    colorScheme,
  });
  const [hasRuntimeContent, setHasRuntimeContent] = useState(false);
  const handleRendered = useCallback(
    (message: {
      revision: number;
      source: string;
      colorScheme: "light" | "dark";
      height: number;
      width: number;
    }) => {
      setHasRuntimeContent(true);
      rendered({
        revision: message.revision,
        source: message.source,
        colorScheme: message.colorScheme,
        dimensions: { height: message.height, width: message.width },
      });
    },
    [rendered],
  );
  const [viewerOpen, setViewerOpen] = useState(false);
  const openViewer = useCallback(() => setViewerOpen(true), []);
  const closeViewer = useCallback(() => setViewerOpen(false), []);
  const visible = state.visible;
  const canShowDiagram = visible !== null && hasRuntimeContent;
  const previewInnerStyle = useMemo(
    () =>
      canShowDiagram && visible
        ? { height: Math.min(visible.height, MAX_PREVIEW_HEIGHT) }
        : previewStyles.measuringInner,
    [canShowDiagram, visible],
  );
  const diagramBoxStyle = getDiagramBoxStyle(textStyle);

  return (
    <>
      {!canShowDiagram ? (
        <HighlightedCodeBlock
          code={code}
          language="mermaid"
          inheritedStyles={inheritedStyles}
          textStyle={textStyle}
        />
      ) : null}
      <Pressable
        onPress={openViewer}
        disabled={!canShowDiagram}
        accessibilityRole={canShowDiagram ? "imagebutton" : undefined}
        accessibilityLabel={t("message.diagram.diagram")}
        style={
          canShowDiagram
            ? [diagramBoxStyle, previewStyles.preview]
            : [diagramBoxStyle, previewStyles.measuring]
        }
      >
        <View style={previewInnerStyle} pointerEvents="none">
          <MermaidWebView
            request={request}
            interactive={false}
            onRendered={handleRendered}
            onRenderFailed={renderFailed}
          />
        </View>
      </Pressable>
      {viewerOpen && canShowDiagram && visible ? (
        <MermaidDiagramViewer
          code={visible.source}
          colorScheme={visible.colorScheme}
          onClose={closeViewer}
          inheritedStyles={inheritedStyles}
          textStyle={textStyle}
        />
      ) : null}
    </>
  );
}

const previewStyles = RNStyleSheet.create({
  measuring: {
    position: "absolute",
    left: 0,
    right: 0,
    opacity: 0,
    pointerEvents: "none",
  },
  measuringInner: { height: 240 },
  preview: { overflow: "hidden" },
});

const mapColorScheme = (theme: Theme) => ({ colorScheme: theme.colorScheme });
const ThemedMermaidFenceHost = withUnistyles(MermaidFenceHostImpl);

export function MermaidFenceHost(props: MarkdownFenceRendererProps) {
  return <ThemedMermaidFenceHost {...props} uniProps={mapColorScheme} />;
}
