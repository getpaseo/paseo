// @ts-nocheck
/**
 * BrowserPane (Web/Electron) — real browser tab using Electron webview.
 * Agent controls this webview via MCP tools through the daemon relay.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import { ArrowLeft, ArrowRight, Globe, RefreshCw, ExternalLink } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { getIsElectron } from "@/constants/platform";
import { openExternalUrl } from "@/utils/open-external-url";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const webviewRef = useRef<any>(null);
  const urlInputRef = useRef<TextInput>(null);
  const isElectron = getIsElectron();

  const [currentUrl, setCurrentUrl] = useState(initialUrl || "about:blank");
  const [urlInput, setUrlInput] = useState(initialUrl || "");
  const [isUrlFocused, setIsUrlFocused] = useState(false);
  const [isLoading, setIsLoading] = useState(!!initialUrl);
  const [pageTitle, setPageTitle] = useState("");
  const [webviewReady, setWebviewReady] = useState(false);

  useEffect(() => {
    if (!isUrlFocused) {
      setUrlInput(currentUrl === "about:blank" ? "" : currentUrl);
    }
  }, [currentUrl, isUrlFocused]);

  // Create webview element imperatively to avoid React/Electron conflicts
  useEffect(() => {
    if (!isElectron || !containerRef.current) return;

    console.log("[BrowserPane] creating webview", { initialUrl, browserId, isElectron });
    const wv = document.createElement("webview") as any;
    wv.setAttribute("src", initialUrl || "about:blank");
    wv.setAttribute("allowpopups", "true");
    wv.setAttribute("partition", "persist:hubcode-browser");
    wv.style.width = "100%";
    wv.style.height = "100%";
    wv.style.flex = "1";
    wv.style.border = "none";
    wv.style.display = "flex";

    containerRef.current.innerHTML = "";
    containerRef.current.appendChild(wv);
    webviewRef.current = wv;

    const onReady = () => setWebviewReady(true);
    const onDidNavigate = (e: any) => {
      setCurrentUrl(e.url);
      setIsLoading(false);
    };
    const onDidNavigateInPage = (e: any) => {
      if (e.isMainFrame) setCurrentUrl(e.url);
    };
    const onStartLoading = () => setIsLoading(true);
    const onStopLoading = () => setIsLoading(false);
    const onTitleUpdate = (e: any) => setPageTitle(e.title || "");
    const onFailLoad = (e: any) => {
      if (e.errorCode !== -3) setIsLoading(false);
    };

    wv.addEventListener("dom-ready", onReady);
    wv.addEventListener("did-navigate", onDidNavigate);
    wv.addEventListener("did-navigate-in-page", onDidNavigateInPage);
    wv.addEventListener("did-start-loading", onStartLoading);
    wv.addEventListener("did-stop-loading", onStopLoading);
    wv.addEventListener("page-title-updated", onTitleUpdate);
    wv.addEventListener("did-fail-load", onFailLoad);

    return () => {
      wv.removeEventListener("dom-ready", onReady);
      wv.removeEventListener("did-navigate", onDidNavigate);
      wv.removeEventListener("did-navigate-in-page", onDidNavigateInPage);
      wv.removeEventListener("did-start-loading", onStartLoading);
      wv.removeEventListener("did-stop-loading", onStopLoading);
      wv.removeEventListener("page-title-updated", onTitleUpdate);
      wv.removeEventListener("did-fail-load", onFailLoad);
      webviewRef.current = null;
      setWebviewReady(false);
    };
    // Only run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isElectron]);

  // Handle agent commands from daemon — execute in webview
  useEffect(() => {
    if (!client || !isElectron || !webviewReady) return;

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
              wv.loadURL(url);
              // Wait for navigation to complete
              await new Promise<void>((resolve) => {
                const handler = () => {
                  wv.removeEventListener("did-stop-loading", handler);
                  resolve();
                };
                wv.addEventListener("did-stop-loading", handler);
                setTimeout(() => {
                  wv.removeEventListener("did-stop-loading", handler);
                  resolve();
                }, 15000);
              });
              const title = wv.getTitle?.() || "";
              const finalUrl = wv.getURL?.() || url;
              sendResult(requestId, true, { url: finalUrl, title });
            }
            break;
          }
          case "click": {
            const selector = args?.selector as string;
            await wv.executeJavaScript(
              `document.querySelector(${JSON.stringify(selector)})?.click()`,
            );
            sendResult(requestId, true);
            break;
          }
          case "fill": {
            const selector = args?.selector as string;
            const value = args?.value as string;
            await wv.executeJavaScript(`
              (function() {
                const el = document.querySelector(${JSON.stringify(selector)});
                if (el) {
                  el.focus();
                  el.value = ${JSON.stringify(value)};
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                }
              })()
            `);
            sendResult(requestId, true);
            break;
          }
          case "evaluate": {
            const expression = args?.expression as string;
            const evalResult = await wv.executeJavaScript(expression);
            sendResult(requestId, true, { result: String(evalResult ?? "") });
            break;
          }
          case "get_text": {
            const text = await wv.executeJavaScript("document.body?.innerText || ''");
            sendResult(requestId, true, { text });
            break;
          }
          case "screenshot": {
            const nativeImage = await wv.capturePage();
            const pngBase64 = nativeImage.toDataURL().replace(/^data:image\/png;base64,/, "");
            sendResult(requestId, true, { data: pngBase64, mimeType: "image/png" });
            break;
          }
          case "go_back": {
            wv.goBack();
            await new Promise((r) => setTimeout(r, 1000));
            sendResult(requestId, true, {
              url: wv.getURL?.() || "",
              title: wv.getTitle?.() || "",
            });
            break;
          }
          case "go_forward": {
            wv.goForward();
            await new Promise((r) => setTimeout(r, 1000));
            sendResult(requestId, true, {
              url: wv.getURL?.() || "",
              title: wv.getTitle?.() || "",
            });
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
  }, [browserId, client, isElectron, webviewReady]);

  const navigateTo = useCallback((url: string) => {
    if (!url.trim()) return;
    const normalizedUrl =
      url.startsWith("http://") || url.startsWith("https://") ? url : `https://${url}`;
    setCurrentUrl(normalizedUrl);
    setIsLoading(true);
    if (webviewRef.current) {
      webviewRef.current.loadURL(normalizedUrl);
    }
  }, []);

  const handleUrlSubmit = useCallback(() => {
    urlInputRef.current?.blur();
    navigateTo(urlInput);
  }, [navigateTo, urlInput]);

  const handleGoBack = useCallback(() => {
    webviewRef.current?.goBack();
  }, []);

  const handleGoForward = useCallback(() => {
    webviewRef.current?.goForward();
  }, []);

  const handleRefresh = useCallback(() => {
    webviewRef.current?.reload();
  }, []);

  const handleOpenExternal = useCallback(() => {
    if (currentUrl && currentUrl !== "about:blank") {
      void openExternalUrl(currentUrl);
    }
  }, [currentUrl]);

  return (
    <View style={styles.container}>
      <View style={styles.navBar}>
        <View style={styles.navControls}>
          <Pressable
            style={({ hovered }) => [styles.navButton, hovered && styles.navButtonHovered]}
            onPress={handleGoBack}
          >
            <ArrowLeft size={14} color={theme.colors.foregroundMuted} strokeWidth={2} />
          </Pressable>
          <Pressable
            style={({ hovered }) => [styles.navButton, hovered && styles.navButtonHovered]}
            onPress={handleGoForward}
          >
            <ArrowRight size={14} color={theme.colors.foregroundMuted} strokeWidth={2} />
          </Pressable>
          <Pressable
            style={({ hovered }) => [styles.navButton, hovered && styles.navButtonHovered]}
            onPress={handleRefresh}
          >
            <RefreshCw size={13} color={theme.colors.foregroundMuted} strokeWidth={2} />
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
            style={styles.urlInput as any}
            autoCapitalize="none"
            autoCorrect={false}
            selectTextOnFocus
          />
          {isLoading && <ActivityIndicator size={10} color={theme.colors.accent} />}
        </View>

        <Pressable
          style={({ hovered }) => [styles.navButton, hovered && styles.navButtonHovered]}
          onPress={handleOpenExternal}
        >
          <ExternalLink size={13} color={theme.colors.foregroundMuted} strokeWidth={2} />
        </Pressable>
      </View>

      {/* Webview container — created imperatively */}
      <div
        ref={containerRef}
        style={{
          flex: 1,
          display: "flex",
          position: "relative",
          width: "100%",
          height: "100%",
          minHeight: 0,
        }}
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
    gap: 2,
  },
  navButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  navButtonHovered: {
    backgroundColor: theme.colors.surface2,
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
    paddingVertical: 4,
    minHeight: 28,
  },
  urlInput: {
    flex: 1,
    fontSize: 13,
    color: theme.colors.foreground,
    outlineStyle: "none",
    paddingVertical: 0,
  },
}));
