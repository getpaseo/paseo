import { useCallback, useEffect, useMemo, useRef } from "react";
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
import { resolvePluginThemeTokens } from "./theme";

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

const ORIGIN_WHITELIST = ["about:blank"];

export function PluginSandbox({ html, context, onOpenFile, onResize, testID }: PluginSandboxProps) {
  const webViewRef = useRef<WebView | null>(null);
  const readyRef = useRef(false);
  const hasLoadedRef = useRef(false);
  const latest = useRef({ context, onOpenFile, onResize });

  useEffect(() => {
    latest.current = { context, onOpenFile, onResize };
  }, [context, onOpenFile, onResize]);

  const source = useMemo(() => ({ html: wrapPluginHtml(html) }), [html]);

  useEffect(() => {
    readyRef.current = false;
    hasLoadedRef.current = false;
  }, [source]);

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
          post(createInitMessage(latest.current.context, resolvePluginThemeTokens()));
        },
        onOpenFile: (input) => latest.current.onOpenFile?.(input),
        onResize: (height) => latest.current.onResize?.(height),
      });
    },
    [post],
  );

  useEffect(() => {
    if (!readyRef.current) {
      return;
    }
    post(createUpdateMessage(context));
  }, [context, post]);

  /** Navigation is locked to the initial load: nothing after it is allowed. */
  const allowInitialLoadOnly = useCallback(() => {
    if (hasLoadedRef.current) {
      return false;
    }
    hasLoadedRef.current = true;
    return true;
  }, []);

  return (
    <WebView
      ref={webViewRef}
      testID={testID}
      style={styles.webView}
      source={source}
      originWhitelist={ORIGIN_WHITELIST}
      onShouldStartLoadWithRequest={allowInitialLoadOnly}
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
