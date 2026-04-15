/**
 * BrowserPane (Native — iOS/Android) — real browser tab using react-native-webview.
 * Agent controls this webview via MCP tools through the daemon relay.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import { WebView, type WebViewNavigation } from "react-native-webview";
import { ArrowLeft, ArrowRight, Globe, RefreshCw, ExternalLink } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { openExternalUrl } from "@/utils/open-external-url";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import * as Linking from "expo-linking";

interface BrowserPaneProps {
  serverId: string;
  cwd: string;
  browserId: string;
  isPaneFocused: boolean;
  initialUrl?: string;
}

export function BrowserPane({
  serverId,
  cwd,
  browserId,
  isPaneFocused,
  initialUrl,
}: BrowserPaneProps) {
  const { theme } = useUnistyles();
  const client = useHostRuntimeClient(serverId);
  const webviewRef = useRef<WebView>(null);
  const urlInputRef = useRef<TextInput>(null);

  const [currentUrl, setCurrentUrl] = useState(initialUrl || "about:blank");
  const [urlInput, setUrlInput] = useState(initialUrl || "");
  const [isUrlFocused, setIsUrlFocused] = useState(false);
  const [isLoading, setIsLoading] = useState(!!initialUrl);
  const [pageTitle, setPageTitle] = useState("");
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);

  useEffect(() => {
    if (!isUrlFocused) {
      setUrlInput(currentUrl === "about:blank" ? "" : currentUrl);
    }
  }, [currentUrl, isUrlFocused]);

  // Handle agent commands from daemon
  useEffect(() => {
    if (!client) return;

    const sendResult = (
      requestId: string,
      success: boolean,
      result?: Record<string, unknown>,
      error?: string,
    ) => {
      (client as any).sendBrowserCommandResult?.({
        requestId,
        browserId,
        success,
        result,
        error,
      });
    };

    const unsub = client.on("browser_command" as any, async (msg: any) => {
      if (msg?.payload?.browserId !== browserId) return;
      const { requestId, command, args } = msg.payload;
      const wv = webviewRef.current;

      if (!wv) {
        sendResult(requestId, false, undefined, "Webview not ready");
        return;
      }

      try {
        switch (command) {
          case "navigate": {
            const url = args?.url as string;
            if (url) {
              const normalizedUrl =
                url.startsWith("http://") || url.startsWith("https://") ? url : `https://${url}`;
              setCurrentUrl(normalizedUrl);
              sendResult(requestId, true, { url: normalizedUrl, title: "" });
            }
            break;
          }
          case "click": {
            const selector = args?.selector as string;
            wv.injectJavaScript(`
              document.querySelector(${JSON.stringify(selector)})?.click();
              true;
            `);
            sendResult(requestId, true);
            break;
          }
          case "fill": {
            const selector = args?.selector as string;
            const value = args?.value as string;
            wv.injectJavaScript(`
              (function() {
                const el = document.querySelector(${JSON.stringify(selector)});
                if (el) {
                  el.focus();
                  el.value = ${JSON.stringify(value)};
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                }
              })();
              true;
            `);
            sendResult(requestId, true);
            break;
          }
          case "evaluate": {
            const expression = args?.expression as string;
            wv.injectJavaScript(`
              window.ReactNativeWebView.postMessage(JSON.stringify({
                __hubcodeEval: true,
                requestId: ${JSON.stringify(requestId)},
                result: String(eval(${JSON.stringify(expression)}))
              }));
              true;
            `);
            // Result comes back via onMessage
            break;
          }
          case "get_text": {
            wv.injectJavaScript(`
              window.ReactNativeWebView.postMessage(JSON.stringify({
                __hubcodeEval: true,
                requestId: ${JSON.stringify(requestId)},
                result: document.body?.innerText || ''
              }));
              true;
            `);
            break;
          }
          case "screenshot": {
            // Native WebView doesn't support capturePage easily
            sendResult(
              requestId,
              false,
              undefined,
              "Screenshot not supported on native — use browser_get_text or browser_evaluate instead",
            );
            break;
          }
          case "go_back": {
            wv.goBack();
            sendResult(requestId, true, { url: currentUrl, title: pageTitle });
            break;
          }
          case "go_forward": {
            wv.goForward();
            sendResult(requestId, true, { url: currentUrl, title: pageTitle });
            break;
          }
          default:
            sendResult(requestId, false, undefined, `Unknown command: ${command}`);
        }
      } catch (err) {
        sendResult(requestId, false, undefined, err instanceof Error ? err.message : String(err));
      }
    });

    return unsub;
  }, [browserId, client, currentUrl, pageTitle]);

  const handleNavigationStateChange = useCallback((navState: WebViewNavigation) => {
    setCurrentUrl(navState.url);
    setPageTitle(navState.title || "");
    setCanGoBack(navState.canGoBack);
    setCanGoForward(navState.canGoForward);
    setIsLoading(navState.loading);
  }, []);

  const handleMessage = useCallback(
    (event: { nativeEvent: { data: string } }) => {
      try {
        const data = JSON.parse(event.nativeEvent.data);
        if (data.__hubcodeEval && data.requestId && client) {
          (client as any).sendBrowserCommandResult?.({
            requestId: data.requestId,
            browserId,
            success: true,
            result: { result: data.result },
          });
        }
      } catch {
        // Ignore non-JSON messages
      }
    },
    [browserId, client],
  );

  const navigateTo = useCallback((url: string) => {
    if (!url.trim()) return;
    const normalizedUrl =
      url.startsWith("http://") || url.startsWith("https://") ? url : `https://${url}`;
    setCurrentUrl(normalizedUrl);
    setIsLoading(true);
  }, []);

  const handleUrlSubmit = useCallback(() => {
    urlInputRef.current?.blur();
    navigateTo(urlInput);
  }, [navigateTo, urlInput]);

  return (
    <View style={styles.container}>
      <View style={styles.navBar}>
        <View style={styles.navControls}>
          <Pressable
            style={[styles.navButton, !canGoBack && styles.navButtonDisabled]}
            onPress={() => webviewRef.current?.goBack()}
            disabled={!canGoBack}
          >
            <ArrowLeft
              size={16}
              color={canGoBack ? theme.colors.foreground : theme.colors.foregroundMuted}
              strokeWidth={2}
            />
          </Pressable>
          <Pressable
            style={[styles.navButton, !canGoForward && styles.navButtonDisabled]}
            onPress={() => webviewRef.current?.goForward()}
            disabled={!canGoForward}
          >
            <ArrowRight
              size={16}
              color={canGoForward ? theme.colors.foreground : theme.colors.foregroundMuted}
              strokeWidth={2}
            />
          </Pressable>
          <Pressable style={styles.navButton} onPress={() => webviewRef.current?.reload()}>
            <RefreshCw size={14} color={theme.colors.foreground} strokeWidth={2} />
          </Pressable>
        </View>

        <View style={styles.urlBar}>
          <Globe size={12} color={theme.colors.foregroundMuted} strokeWidth={2} />
          <TextInput
            ref={urlInputRef}
            value={urlInput}
            onChangeText={setUrlInput}
            onFocus={() => setIsUrlFocused(true)}
            onBlur={() => setIsUrlFocused(false)}
            onSubmitEditing={handleUrlSubmit}
            placeholder="Enter URL..."
            placeholderTextColor={theme.colors.foregroundMuted}
            style={styles.urlInput}
            autoCapitalize="none"
            autoCorrect={false}
            selectTextOnFocus
            returnKeyType="go"
            keyboardType="url"
          />
          {isLoading && <ActivityIndicator size="small" color={theme.colors.accent} />}
        </View>

        <Pressable
          style={styles.navButton}
          onPress={() => {
            if (currentUrl && currentUrl !== "about:blank") {
              void Linking.openURL(currentUrl);
            }
          }}
        >
          <ExternalLink size={14} color={theme.colors.foregroundMuted} strokeWidth={2} />
        </Pressable>
      </View>

      <WebView
        ref={webviewRef}
        source={{ uri: currentUrl }}
        style={styles.webview}
        onNavigationStateChange={handleNavigationStateChange}
        onMessage={handleMessage}
        javaScriptEnabled
        domStorageEnabled
        startInLoadingState
        allowsInlineMediaPlayback
        allowsBackForwardNavigationGestures
        renderLoading={() => (
          <View style={styles.loadingOverlay}>
            <ActivityIndicator size="large" color={theme.colors.accent} />
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  navBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surface2,
    backgroundColor: theme.colors.surface1,
  },
  navControls: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  navButton: {
    width: 32,
    height: 32,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  navButtonDisabled: {
    opacity: 0.4,
  },
  urlBar: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface0,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 6,
    minHeight: 32,
  },
  urlInput: {
    flex: 1,
    fontSize: 14,
    color: theme.colors.foreground,
  },
  webview: {
    flex: 1,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface0,
  },
}));
