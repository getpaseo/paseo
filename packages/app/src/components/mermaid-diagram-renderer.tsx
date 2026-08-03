import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { StyleSheet } from "react-native-unistyles";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { useHorizontalScrollOptional } from "@/contexts/horizontal-scroll-context";
import { useMobilePanelOpenGestureRefs } from "@/mobile-panels/gestures";
import type { MermaidCameraState } from "./mermaid-diagram-dom-camera";
import type { MermaidDiagramPalette } from "./mermaid-diagram-render";
import { mermaidWebViewHtml } from "@/mermaid/webview/html";

export interface MermaidDiagramRendererHandle {
  fit: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
}

export interface MermaidDiagramRendererProps {
  code: string;
  palette: MermaidDiagramPalette;
  onCameraStateChange: (state: MermaidCameraState) => void;
  onError: () => void;
  onRendered: () => void;
}

interface WebViewMessage {
  type: "ready" | "rendered" | "camera" | "error";
  canZoomIn?: boolean;
  canZoomOut?: boolean;
}

const WEBVIEW_SOURCE = { html: mermaidWebViewHtml, baseUrl: "about:blank" };
const ORIGIN_WHITELIST = ["*"];

function parseWebViewMessage(serialized: string): WebViewMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const type = Reflect.get(value, "type");
  if (type !== "ready" && type !== "rendered" && type !== "camera" && type !== "error") {
    return null;
  }
  return {
    type,
    canZoomIn: Reflect.get(value, "canZoomIn") === true,
    canZoomOut: Reflect.get(value, "canZoomOut") === true,
  };
}

export const MermaidDiagramRenderer = forwardRef<
  MermaidDiagramRendererHandle,
  MermaidDiagramRendererProps
>(function MermaidDiagramRenderer(
  { code, palette, onCameraStateChange, onError, onRendered },
  ref,
) {
  const webViewRef = useRef<WebView>(null);
  const bridgeReadyRef = useRef(false);
  const mobilePanelGestureSuppressed = useHorizontalScrollOptional()?.isGestureSuppressed;
  const { leftOpenGestureRef, rightOpenGestureRef } = useMobilePanelOpenGestureRefs();
  const renderMessage = useMemo(
    () => ({
      type: "render",
      code,
      palette,
      panBehavior: "rubber-band",
    }),
    [code, palette],
  );
  const interactionBoundaryGesture = useMemo(
    () =>
      Gesture.Native()
        .blocksExternalGesture(leftOpenGestureRef, rightOpenGestureRef)
        .shouldActivateOnStart(true)
        .shouldCancelWhenOutside(false)
        .disallowInterruption(true)
        .onTouchesDown(() => {
          if (mobilePanelGestureSuppressed) {
            mobilePanelGestureSuppressed.value = true;
          }
        })
        .onTouchesUp(() => {
          if (mobilePanelGestureSuppressed) {
            mobilePanelGestureSuppressed.value = false;
          }
        })
        .onTouchesCancelled(() => {
          if (mobilePanelGestureSuppressed) {
            mobilePanelGestureSuppressed.value = false;
          }
        })
        .onFinalize(() => {
          if (mobilePanelGestureSuppressed) {
            mobilePanelGestureSuppressed.value = false;
          }
        }),
    [leftOpenGestureRef, mobilePanelGestureSuppressed, rightOpenGestureRef],
  );

  const send = useCallback((message: object) => {
    const serialized = JSON.stringify(JSON.stringify(message));
    webViewRef.current?.injectJavaScript(
      `window.__PASEO_MERMAID_RECEIVE__?.(${serialized}); true;`,
    );
  }, []);
  const allowOnlyBundledDocument = useCallback(({ url }: { url: string }) => {
    return url === "about:blank";
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      fit: () => send({ type: "fit" }),
      zoomIn: () => send({ type: "zoomIn" }),
      zoomOut: () => send({ type: "zoomOut" }),
    }),
    [send],
  );

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const message = parseWebViewMessage(event.nativeEvent.data);
      if (!message) {
        onError();
        return;
      }
      if (message.type === "ready") {
        bridgeReadyRef.current = true;
        send(renderMessage);
      } else if (message.type === "rendered") {
        onRendered();
      } else if (message.type === "camera") {
        onCameraStateChange({
          canZoomIn: message.canZoomIn === true,
          canZoomOut: message.canZoomOut === true,
        });
      } else {
        onError();
      }
    },
    [onCameraStateChange, onError, onRendered, renderMessage, send],
  );

  useEffect(() => {
    if (bridgeReadyRef.current) {
      send(renderMessage);
    }
  }, [renderMessage, send]);

  return (
    <GestureDetector gesture={interactionBoundaryGesture}>
      <WebView
        ref={webViewRef}
        testID="mermaid-diagram-viewport"
        style={styles.webview}
        source={WEBVIEW_SOURCE}
        originWhitelist={ORIGIN_WHITELIST}
        onMessage={handleMessage}
        onError={onError}
        onHttpError={onError}
        onShouldStartLoadWithRequest={allowOnlyBundledDocument}
        setSupportMultipleWindows={false}
        javaScriptCanOpenWindowsAutomatically={false}
        domStorageEnabled={false}
        thirdPartyCookiesEnabled={false}
        cacheEnabled={false}
        incognito
        nestedScrollEnabled
        scrollEnabled={false}
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        overScrollMode="never"
      />
    </GestureDetector>
  );
});

const styles = StyleSheet.create(() => ({
  webview: {
    flex: 1,
    backgroundColor: "transparent",
  },
}));
