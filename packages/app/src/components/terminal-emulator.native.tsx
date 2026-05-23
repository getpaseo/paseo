import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type Ref,
} from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import type { ITheme } from "@xterm/xterm";
import type { TerminalState } from "@server/shared/messages";
import type { TerminalInputModeState } from "@server/shared/terminal-input-mode";
import type { TerminalOutputData } from "../terminal/runtime/terminal-emulator-runtime";
import { terminalEmulatorWebViewHtml } from "../terminal/webview/terminal-emulator-webview-html";
import type { PendingTerminalModifiers } from "../utils/terminal-keys";
import type { TerminalRendererReadyChange } from "../utils/terminal-renderer-readiness";
import { openExternalUrl } from "../utils/open-external-url";

export interface TerminalEmulatorHandle {
  writeOutput: (data: TerminalOutputData) => void;
  restoreOutput: (data: TerminalOutputData) => void;
  renderSnapshot: (state: TerminalState | null) => void;
  clear: () => void;
}

interface TerminalEmulatorProps {
  dom?: unknown;
  ref: Ref<TerminalEmulatorHandle>;
  streamKey: string;
  testId?: string;
  xtermTheme?: ITheme;
  scrollbackLines: number;
  swipeGesturesEnabled?: boolean;
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  initialSnapshot?: TerminalState | null;
  onInput?: (data: string) => Promise<void> | void;
  onResize?: (input: { rows: number; cols: number }) => Promise<void> | void;
  onTerminalKey?: (input: {
    key: string;
    ctrl: boolean;
    shift: boolean;
    alt: boolean;
    meta: boolean;
  }) => Promise<void> | void;
  onPendingModifiersConsumed?: () => Promise<void> | void;
  onInputModeChange?: (state: TerminalInputModeState) => Promise<void> | void;
  onRendererReadyChange?: (change: TerminalRendererReadyChange) => void;
  pendingModifiers?: PendingTerminalModifiers;
  focusRequestToken?: number;
  resizeRequestToken?: number;
}

type BridgeInboundMessage =
  | {
      type: "mount";
      streamKey: string;
      initialSnapshot: TerminalState | null;
      scrollbackLines: number;
      theme: ITheme;
      pendingModifiers: PendingTerminalModifiers;
      swipeGesturesEnabled: boolean;
    }
  | { type: "unmount"; streamKey: string }
  | { type: "writeOutput"; streamKey: string; text: string }
  | { type: "restoreOutput"; streamKey: string; text: string }
  | { type: "renderSnapshot"; streamKey: string; state: TerminalState | null }
  | { type: "clear"; streamKey: string }
  | { type: "focus"; streamKey: string }
  | { type: "resize"; streamKey: string }
  | { type: "setTheme"; streamKey: string; theme: ITheme }
  | { type: "setScrollback"; streamKey: string; lines: number }
  | { type: "setPendingModifiers"; streamKey: string; pendingModifiers: PendingTerminalModifiers }
  | { type: "setSwipeGesturesEnabled"; streamKey: string; enabled: boolean };

type BridgeOutboundMessage =
  | { type: "bridgeReady" }
  | { type: "rendererReady"; streamKey: string; isReady: boolean }
  | { type: "input"; streamKey: string; data: string }
  | { type: "resize"; streamKey: string; rows: number; cols: number }
  | {
      type: "terminalKey";
      streamKey: string;
      key: string;
      ctrl: boolean;
      shift: boolean;
      alt: boolean;
      meta: boolean;
    }
  | { type: "pendingModifiersConsumed"; streamKey: string }
  | { type: "inputModeChange"; streamKey: string; state: TerminalInputModeState }
  | { type: "openExternalUrl"; streamKey: string; url: string }
  | { type: "swipeLeft"; streamKey: string }
  | { type: "swipeRight"; streamKey: string }
  | { type: "debug"; message: string; details?: unknown };

const TERMINAL_WEBVIEW_SOURCE = { html: terminalEmulatorWebViewHtml };
const TERMINAL_WEBVIEW_ORIGIN_WHITELIST = ["*"];
const BRIDGE_READY_TIMEOUT_MS = 2_500;
const RENDERER_READY_TIMEOUT_MS = 2_500;
type WebViewProps = ComponentProps<typeof WebView>;

function buildThemeKey(theme: ITheme): string {
  return JSON.stringify(theme);
}

function serializeForInjectedJavaScript(message: BridgeInboundMessage): string {
  return JSON.stringify(message).replace(/<\/script/gi, "<\\/script");
}

function createMountMessage(input: {
  streamKey: string;
  initialSnapshot: TerminalState | null;
  scrollbackLines: number;
  theme: ITheme;
  pendingModifiers: PendingTerminalModifiers;
  swipeGesturesEnabled: boolean;
}): BridgeInboundMessage {
  return {
    type: "mount",
    streamKey: input.streamKey,
    initialSnapshot: input.initialSnapshot,
    scrollbackLines: input.scrollbackLines,
    theme: input.theme,
    pendingModifiers: input.pendingModifiers,
    swipeGesturesEnabled: input.swipeGesturesEnabled,
  };
}

export default function TerminalEmulator({
  ref,
  streamKey,
  testId = "terminal-surface",
  xtermTheme = {
    background: "#0b0b0b",
    foreground: "#e6e6e6",
    cursor: "#e6e6e6",
  },
  scrollbackLines,
  swipeGesturesEnabled = false,
  onSwipeLeft,
  onSwipeRight,
  initialSnapshot = null,
  onInput,
  onResize,
  onTerminalKey,
  onPendingModifiersConsumed,
  onInputModeChange,
  onRendererReadyChange,
  pendingModifiers = { ctrl: false, shift: false, alt: false },
  focusRequestToken = 0,
  resizeRequestToken = 0,
}: TerminalEmulatorProps) {
  const webViewRef = useRef<WebView>(null);
  const [webViewEpoch, setWebViewEpoch] = useState(0);
  const [bridgeReadyVersion, setBridgeReadyVersion] = useState(0);
  const bridgeReadyRef = useRef(false);
  const bridgeReadyVersionRef = useRef(0);
  const rendererReadyVersionRef = useRef(0);
  const pendingMessagesRef = useRef<BridgeInboundMessage[]>([]);
  const outputDecoderRef = useRef(new TextDecoder());
  const mountedStreamKeyRef = useRef<string | null>(null);
  const bridgeReadyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rendererReadyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountConfigRef = useRef({
    streamKey,
    initialSnapshot,
    scrollbackLines,
    theme: xtermTheme,
    pendingModifiers,
    swipeGesturesEnabled,
  });
  mountConfigRef.current = {
    streamKey,
    initialSnapshot,
    scrollbackLines,
    theme: xtermTheme,
    pendingModifiers,
    swipeGesturesEnabled,
  };
  const callbacksRef = useRef({
    onInput,
    onResize,
    onTerminalKey,
    onPendingModifiersConsumed,
    onInputModeChange,
    onRendererReadyChange,
    onSwipeLeft,
    onSwipeRight,
  });
  callbacksRef.current = {
    onInput,
    onResize,
    onTerminalKey,
    onPendingModifiersConsumed,
    onInputModeChange,
    onRendererReadyChange,
    onSwipeLeft,
    onSwipeRight,
  };

  const clearBridgeReadyTimeout = useCallback(() => {
    if (bridgeReadyTimeoutRef.current === null) return;
    clearTimeout(bridgeReadyTimeoutRef.current);
    bridgeReadyTimeoutRef.current = null;
  }, []);

  const clearRendererReadyTimeout = useCallback(() => {
    if (rendererReadyTimeoutRef.current === null) return;
    clearTimeout(rendererReadyTimeoutRef.current);
    rendererReadyTimeoutRef.current = null;
  }, []);

  const resetWebViewDocument = useCallback(() => {
    clearBridgeReadyTimeout();
    clearRendererReadyTimeout();
    bridgeReadyRef.current = false;
    pendingMessagesRef.current = [];
    mountedStreamKeyRef.current = null;
    callbacksRef.current.onRendererReadyChange?.({ streamKey, isReady: false });
    setWebViewEpoch((value) => value + 1);
  }, [clearBridgeReadyTimeout, clearRendererReadyTimeout, streamKey]);

  const scheduleBridgeReadyWatchdog = useCallback(() => {
    clearBridgeReadyTimeout();
    const expectedBridgeReadyVersion = bridgeReadyVersionRef.current;
    bridgeReadyTimeoutRef.current = setTimeout(() => {
      bridgeReadyTimeoutRef.current = null;
      if (bridgeReadyVersionRef.current !== expectedBridgeReadyVersion || bridgeReadyRef.current) {
        return;
      }
      resetWebViewDocument();
    }, BRIDGE_READY_TIMEOUT_MS);
  }, [clearBridgeReadyTimeout, resetWebViewDocument]);

  const scheduleRendererReadyWatchdog = useCallback(() => {
    clearRendererReadyTimeout();
    const expectedRendererReadyVersion = rendererReadyVersionRef.current;
    rendererReadyTimeoutRef.current = setTimeout(() => {
      rendererReadyTimeoutRef.current = null;
      if (
        rendererReadyVersionRef.current !== expectedRendererReadyVersion ||
        mountedStreamKeyRef.current === streamKey
      ) {
        return;
      }
      resetWebViewDocument();
    }, RENDERER_READY_TIMEOUT_MS);
  }, [clearRendererReadyTimeout, resetWebViewDocument, streamKey]);

  const flushPendingMessages = useCallback(() => {
    if (!bridgeReadyRef.current || !webViewRef.current) return;
    const pending = pendingMessagesRef.current.splice(0);
    for (const message of pending) {
      const payload = serializeForInjectedJavaScript(message);
      webViewRef.current.injectJavaScript(
        `window.__PASEO_TERMINAL_WEBVIEW_RECEIVE__ && window.__PASEO_TERMINAL_WEBVIEW_RECEIVE__(${payload}); true;`,
      );
    }
  }, []);

  const sendToWebView = useCallback((message: BridgeInboundMessage) => {
    if (!bridgeReadyRef.current || !webViewRef.current) {
      pendingMessagesRef.current.push(message);
      return;
    }
    const payload = serializeForInjectedJavaScript(message);
    webViewRef.current.injectJavaScript(
      `window.__PASEO_TERMINAL_WEBVIEW_RECEIVE__ && window.__PASEO_TERMINAL_WEBVIEW_RECEIVE__(${payload}); true;`,
    );
  }, []);

  useImperativeHandle(
    ref,
    (): TerminalEmulatorHandle => ({
      writeOutput: (data: TerminalOutputData) => {
        const output = outputDecoderRef.current.decode(data, { stream: true });
        if (output.length === 0) {
          return;
        }
        sendToWebView({ type: "writeOutput", streamKey, text: output });
      },
      restoreOutput: (data: TerminalOutputData) => {
        outputDecoderRef.current.decode();
        const text = outputDecoderRef.current.decode(data, { stream: false });
        if (text.length === 0) {
          return;
        }
        sendToWebView({ type: "restoreOutput", streamKey, text });
      },
      renderSnapshot: (state: TerminalState | null) => {
        outputDecoderRef.current.decode();
        sendToWebView({ type: "renderSnapshot", streamKey, state });
      },
      clear: () => {
        outputDecoderRef.current.decode();
        sendToWebView({ type: "clear", streamKey });
      },
    }),
    [sendToWebView, streamKey],
  );

  useEffect(() => {
    outputDecoderRef.current.decode();
  }, [streamKey]);

  useEffect(() => {
    if (bridgeReadyVersion <= 0) return;
    const mountMessage = createMountMessage(mountConfigRef.current);
    mountedStreamKeyRef.current = streamKey;
    sendToWebView(mountMessage);
    flushPendingMessages();
    scheduleRendererReadyWatchdog();
  }, [
    bridgeReadyVersion,
    flushPendingMessages,
    scheduleRendererReadyWatchdog,
    sendToWebView,
    streamKey,
  ]);

  const themeKey = useMemo(() => buildThemeKey(xtermTheme), [xtermTheme]);
  useEffect(() => {
    if (!mountedStreamKeyRef.current) return;
    sendToWebView({ type: "setTheme", streamKey, theme: xtermTheme });
  }, [sendToWebView, streamKey, themeKey, xtermTheme]);

  useEffect(() => {
    if (!mountedStreamKeyRef.current) return;
    sendToWebView({ type: "setScrollback", streamKey, lines: scrollbackLines });
  }, [scrollbackLines, sendToWebView, streamKey]);

  useEffect(() => {
    if (!mountedStreamKeyRef.current) return;
    sendToWebView({ type: "setPendingModifiers", streamKey, pendingModifiers });
  }, [pendingModifiers, sendToWebView, streamKey]);

  useEffect(() => {
    if (!mountedStreamKeyRef.current) return;
    sendToWebView({ type: "setSwipeGesturesEnabled", streamKey, enabled: swipeGesturesEnabled });
  }, [sendToWebView, streamKey, swipeGesturesEnabled]);

  useEffect(() => {
    if (focusRequestToken <= 0) return;
    sendToWebView({ type: "resize", streamKey });
    sendToWebView({ type: "focus", streamKey });
    webViewRef.current?.requestFocus();
  }, [focusRequestToken, sendToWebView, streamKey]);

  useEffect(() => {
    if (resizeRequestToken <= 0) return;
    sendToWebView({ type: "resize", streamKey });
  }, [resizeRequestToken, sendToWebView, streamKey]);

  useEffect(() => {
    return () => {
      if (mountedStreamKeyRef.current) {
        const previousStreamKey = mountedStreamKeyRef.current;
        callbacksRef.current.onRendererReadyChange?.({
          streamKey: previousStreamKey,
          isReady: false,
        });
        sendToWebView({ type: "unmount", streamKey: previousStreamKey });
      }
      bridgeReadyRef.current = false;
      pendingMessagesRef.current = [];
      mountedStreamKeyRef.current = null;
      clearBridgeReadyTimeout();
      clearRendererReadyTimeout();
    };
  }, [clearBridgeReadyTimeout, clearRendererReadyTimeout, sendToWebView]);

  const handleLifecycleMessage = useCallback(
    (message: BridgeOutboundMessage): boolean => {
      if (message.type === "bridgeReady") {
        bridgeReadyRef.current = true;
        bridgeReadyVersionRef.current += 1;
        clearBridgeReadyTimeout();
        setBridgeReadyVersion((value) => value + 1);
        return true;
      }
      if (message.type === "rendererReady") {
        mountedStreamKeyRef.current = message.isReady ? message.streamKey : null;
        if (message.isReady) {
          rendererReadyVersionRef.current += 1;
          clearRendererReadyTimeout();
        }
        callbacksRef.current.onRendererReadyChange?.({
          streamKey: message.streamKey,
          isReady: message.isReady,
        });
        return true;
      }
      return false;
    },
    [clearBridgeReadyTimeout, clearRendererReadyTimeout],
  );

  const handleTerminalMessage = useCallback(
    (
      message: Exclude<BridgeOutboundMessage, { type: "bridgeReady" } | { type: "rendererReady" }>,
    ) => {
      switch (message.type) {
        case "input":
          callbacksRef.current.onInput?.(message.data);
          break;
        case "resize":
          callbacksRef.current.onResize?.({ rows: message.rows, cols: message.cols });
          break;
        case "terminalKey":
          callbacksRef.current.onTerminalKey?.({
            key: message.key,
            ctrl: message.ctrl,
            shift: message.shift,
            alt: message.alt,
            meta: message.meta,
          });
          break;
        case "pendingModifiersConsumed":
          callbacksRef.current.onPendingModifiersConsumed?.();
          break;
        case "inputModeChange":
          callbacksRef.current.onInputModeChange?.(message.state);
          break;
        case "openExternalUrl":
          void openExternalUrl(message.url);
          break;
        case "swipeLeft":
          callbacksRef.current.onSwipeLeft?.();
          break;
        case "swipeRight":
          callbacksRef.current.onSwipeRight?.();
          break;
        case "debug":
          break;
      }
    },
    [],
  );

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let message: BridgeOutboundMessage;
      try {
        message = JSON.parse(event.nativeEvent.data) as BridgeOutboundMessage;
      } catch {
        return;
      }

      if (message.type === "bridgeReady" || message.type === "rendererReady") {
        handleLifecycleMessage(message);
        return;
      }
      handleTerminalMessage(message);
    },
    [handleLifecycleMessage, handleTerminalMessage],
  );

  const handleLoadStart = useCallback<NonNullable<WebViewProps["onLoadStart"]>>(() => {
    bridgeReadyRef.current = false;
    mountedStreamKeyRef.current = null;
    scheduleBridgeReadyWatchdog();
  }, [scheduleBridgeReadyWatchdog]);

  const handleContentProcessDidTerminate = useCallback<
    NonNullable<WebViewProps["onContentProcessDidTerminate"]>
  >(() => {
    resetWebViewDocument();
  }, [resetWebViewDocument]);

  const handleRenderProcessGone = useCallback<
    NonNullable<WebViewProps["onRenderProcessGone"]>
  >(() => {
    resetWebViewDocument();
  }, [resetWebViewDocument]);

  const webViewStyle = useMemo<StyleProp<ViewStyle>>(
    () => [styles.webView, { backgroundColor: xtermTheme.background ?? "#0b0b0b" }],
    [xtermTheme.background],
  );

  return (
    <View style={styles.root} testID={testId}>
      <WebView
        key={webViewEpoch}
        ref={webViewRef}
        source={TERMINAL_WEBVIEW_SOURCE}
        style={webViewStyle}
        containerStyle={styles.webViewContainer}
        originWhitelist={TERMINAL_WEBVIEW_ORIGIN_WHITELIST}
        scrollEnabled
        nestedScrollEnabled
        bounces={false}
        overScrollMode="never"
        keyboardDisplayRequiresUserAction={false}
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        textInteractionEnabled={false}
        allowsLinkPreview={false}
        setSupportMultipleWindows={false}
        setBuiltInZoomControls={false}
        setDisplayZoomControls={false}
        textZoom={100}
        onMessage={handleMessage}
        onLoadStart={handleLoadStart}
        onContentProcessDidTerminate={handleContentProcessDidTerminate}
        onRenderProcessGone={handleRenderProcessGone}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    overflow: "hidden",
    backgroundColor: "#0b0b0b",
  },
  webView: {
    flex: 1,
    backgroundColor: "#0b0b0b",
  },
  webViewContainer: {
    flex: 1,
    backgroundColor: "#0b0b0b",
  },
});
