import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { Text, View } from "react-native";
import { WebView } from "react-native-webview";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveTextInput } from "@/components/adaptive-text-input";
import { PaneContentToolbar, ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { ArrowLeft, ArrowRight, RotateCw } from "@/components/icons/ui-icons";
import { useBrowserStore, normalizeWorkspaceBrowserUrl } from "@/desktop/browser/store";
import {
  MIRROR_CAPTURE_MARK,
  MIRROR_CAPTURE_SOURCE,
  mirrorReplayReadySource,
  publishLocalMirrorCapture,
  subscribeBrowserMirrorReplay,
} from "@/desktop/browser/mirror";
import { isBrowserRunLocked, useBrowserActivity } from "@/desktop/browser/activity";
import { originalBrowserUrl, resolveBrowserUrl } from "@/desktop/browser/tunnel";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

interface BrowserPaneProps {
  browserId: string;
  serverId: string;
  workspaceId: string;
  cwd: string | null;
  isInteractive?: boolean;
  onFocusPane?: () => void;
}

const capture = MIRROR_CAPTURE_SOURCE.replace(
  "const log = console.debug.bind(console);",
  "const log = (message) => window.ReactNativeWebView.postMessage(message);",
);
const FOLLOW_UP_NAVIGATION_MS = 2500;
const pageUrl = (url: string) => {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
};

export function BrowserPane({ browserId, serverId, workspaceId, onFocusPane }: BrowserPaneProps) {
  const browser = useBrowserStore((state) => state.browsersById[browserId]);
  const remoteBrowserId = browser?.remoteBrowserId;
  const client = useHostRuntimeClient(serverId);
  const activity = useBrowserActivity(serverId, workspaceId, remoteBrowserId ?? undefined);
  const webview = useRef<WebView>(null);
  const initialUrl = useRef(browser?.url ?? "about:blank");
  const initialization = useRef<Promise<void> | null>(null);
  const navigationRequest = useRef(0);
  const [sourceUrl, setSourceUrl] = useState("about:blank");
  const [draftUrl, setDraftUrl] = useState(initialUrl.current);
  const localUrl = useRef(sourceUrl);
  const mirroring = useRef(false);
  const lastMirroredStepAt = useRef(0);
  const lastCompletedUrl = useRef(pageUrl(initialUrl.current));
  const cursor = useRef({ at: 0 });
  const pending = useRef(
    new Map<string, { resolve: () => void; reject: (error: Error) => void }>(),
  );
  const sequence = useRef(0);
  const loading = useRef(true);
  const load = useRef({ generation: 0, url: pageUrl(sourceUrl), started: false });
  const loadWaiters = useRef(
    new Set<{ generation: number; resolve: () => void; reject: (error: Error) => void }>(),
  );
  const update = useCallback(
    (patch: Parameters<ReturnType<typeof useBrowserStore.getState>["updateBrowser"]>[1]) =>
      useBrowserStore.getState().updateBrowser(browserId, patch),
    [browserId],
  );

  const waitForLoad = useCallback(
    () =>
      new Promise<void>((resolve, reject) => {
        if (!loading.current) {
          resolve();
          return;
        }
        const waiter = {
          generation: load.current.generation,
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
          reject: (error: Error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        const timer = setTimeout(() => {
          loadWaiters.current.delete(waiter);
          reject(new Error("Local browser load timed out"));
        }, 15000);
        loadWaiters.current.add(waiter);
      }),
    [],
  );
  const finishLoad = useCallback((error?: Error, generation = load.current.generation) => {
    loading.current = false;
    for (const waiter of loadWaiters.current) {
      if (waiter.generation !== generation) continue;
      if (error) waiter.reject(error);
      else waiter.resolve();
      loadWaiters.current.delete(waiter);
    }
  }, []);
  const beginNavigation = useCallback(
    (url: string) => {
      for (const waiter of loadWaiters.current) {
        waiter.reject(new Error("Local browser navigation changed"));
      }
      loadWaiters.current.clear();
      load.current = { generation: load.current.generation + 1, url: pageUrl(url), started: false };
      loading.current = true;
      setSourceUrl(url);
      update({ url: originalBrowserUrl(url), isLoading: true, lastError: null });
    },
    [update],
  );
  const navigateTo = useCallback(
    async (url: string) => {
      if (!client || !remoteBrowserId) throw new Error("Browser host is unavailable");
      const request = ++navigationRequest.current;
      const deviceUrl = await resolveBrowserUrl({
        client,
        serverId,
        workspaceId,
        browserId: remoteBrowserId,
        url,
      });
      if (request !== navigationRequest.current) return;
      const target = pageUrl(deviceUrl);
      if (
        (loading.current && load.current.url === target) ||
        (!loading.current && pageUrl(localUrl.current) === target)
      ) {
        return;
      }
      beginNavigation(deviceUrl);
    },
    [beginNavigation, client, remoteBrowserId, serverId, workspaceId],
  );
  const initializeNavigation = useCallback(() => {
    initialization.current ??= navigateTo(initialUrl.current);
    return initialization.current;
  }, [navigateTo]);
  useEffect(() => {
    if (!client || !remoteBrowserId) return;
    void initializeNavigation().catch((error) =>
      update({
        isLoading: false,
        lastError: error instanceof Error ? error.message : String(error),
      }),
    );
  }, [client, initializeNavigation, remoteBrowserId, update]);

  useEffect(() => {
    if (!remoteBrowserId || !client) return;
    return subscribeBrowserMirrorReplay({
      serverId,
      browserId: remoteBrowserId,
      cursor: cursor.current,
      replay: async (action) => {
        mirroring.current = true;
        lastMirroredStepAt.current = Date.now();
        try {
          await initializeNavigation().catch((error) => {
            if (action.kind !== "navigate") throw error;
          });
          if (action.kind === "navigate") {
            await navigateTo(action.url);
            await waitForLoad();
          } else {
            await waitForLoad();
            const id = String(++sequence.current);
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => {
                pending.current.delete(id);
                reject(new Error("Local browser replay timed out"));
              }, 10000);
              pending.current.set(id, {
                resolve: () => {
                  clearTimeout(timer);
                  resolve();
                },
                reject: (error) => {
                  clearTimeout(timer);
                  reject(error);
                },
              });
              webview.current?.injectJavaScript(
                `(${mirrorReplayReadySource(action)})().then(() => window.ReactNativeWebView.postMessage(JSON.stringify({mirrorAck:${JSON.stringify(id)}}))).catch(error => window.ReactNativeWebView.postMessage(JSON.stringify({mirrorAck:${JSON.stringify(id)},error:String(error.message)})));true;`,
              );
            });
          }
        } finally {
          lastMirroredStepAt.current = Date.now();
          mirroring.current = false;
        }
      },
      onError: (error) =>
        update({ lastError: error instanceof Error ? error.message : String(error) }),
    });
  }, [
    client,
    initializeNavigation,
    navigateTo,
    browserId,
    remoteBrowserId,
    serverId,
    update,
    waitForLoad,
  ]);

  useEffect(
    () => () => {
      const error = new Error("Local browser closed");
      navigationRequest.current += 1;
      for (const waiter of loadWaiters.current) waiter.reject(error);
      loadWaiters.current.clear();
      for (const request of pending.current.values()) request.reject(error);
      pending.current.clear();
    },
    [],
  );
  useEffect(() => setDraftUrl(browser?.url ?? sourceUrl), [browser?.url, sourceUrl]);

  const source = useMemo(() => ({ uri: sourceUrl }), [sourceUrl]);
  const goBack = useCallback(() => {
    lastMirroredStepAt.current = 0;
    webview.current?.goBack();
  }, []);
  const goForward = useCallback(() => {
    lastMirroredStepAt.current = 0;
    webview.current?.goForward();
  }, []);
  const reload = useCallback(() => webview.current?.reload(), []);
  const navigate = useCallback(() => {
    lastMirroredStepAt.current = 0;
    void navigateTo(normalizeWorkspaceBrowserUrl(draftUrl)).catch((error) =>
      update({
        isLoading: false,
        lastError: error instanceof Error ? error.message : String(error),
      }),
    );
  }, [navigateTo, draftUrl, update]);
  const handleLoadStart = useCallback<NonNullable<ComponentProps<typeof WebView>["onLoadStart"]>>(
    ({ nativeEvent }) => {
      const url = pageUrl(nativeEvent.url);
      // A replaced initial document can finish after a newer source has been requested.
      if (!load.current.started && load.current.url !== url) return;
      if (!loading.current) load.current.generation += 1;
      load.current.url = url;
      load.current.started = true;
      loading.current = true;
      update({ isLoading: true });
    },
    [update],
  );
  const handleLoad = useCallback<NonNullable<ComponentProps<typeof WebView>["onLoad"]>>(
    ({ nativeEvent }) => {
      if (!load.current.started || load.current.url !== pageUrl(nativeEvent.url)) return;
      update({ isLoading: false });
      finishLoad();
    },
    [update, finishLoad],
  );
  const handleError = useCallback<NonNullable<ComponentProps<typeof WebView>["onError"]>>(
    ({ nativeEvent }) => {
      if (load.current.url !== pageUrl(nativeEvent.url)) return;
      const error = new Error(nativeEvent.description);
      update({ isLoading: false, lastError: error.message });
      finishLoad(error);
    },
    [update, finishLoad],
  );
  const handleNavigation = useCallback<
    NonNullable<ComponentProps<typeof WebView>["onNavigationStateChange"]>
  >(
    (state) => {
      const url = pageUrl(state.url);
      if (state.url === "about:blank" && initialUrl.current !== "about:blank") return;
      if (loading.current && (!load.current.started || load.current.url !== url)) return;
      localUrl.current = state.url;
      const originalUrl = originalBrowserUrl(state.url);
      update({
        url: originalUrl,
        title: state.title,
        canGoBack: state.canGoBack,
        canGoForward: state.canGoForward,
      });
      if (state.loading || pageUrl(originalUrl) === lastCompletedUrl.current) return;
      lastCompletedUrl.current = pageUrl(originalUrl);
      if (
        !mirroring.current &&
        Date.now() - lastMirroredStepAt.current >= FOLLOW_UP_NAVIGATION_MS &&
        /^https?:/i.test(state.url)
      ) {
        publishLocalMirrorCapture(
          browserId,
          MIRROR_CAPTURE_MARK + JSON.stringify({ kind: "navigate", url: originalUrl }),
        );
      }
    },
    [browserId, update],
  );
  const handleMessage = useCallback<NonNullable<ComponentProps<typeof WebView>["onMessage"]>>(
    ({ nativeEvent }) => {
      if (nativeEvent.data.startsWith(MIRROR_CAPTURE_MARK)) {
        lastMirroredStepAt.current = Date.now();
        publishLocalMirrorCapture(browserId, nativeEvent.data);
        return;
      }
      try {
        const message: { mirrorAck?: string; error?: string } = JSON.parse(nativeEvent.data);
        if (typeof message.mirrorAck !== "string") return;
        const request = pending.current.get(message.mirrorAck);
        if (!request) return;
        pending.current.delete(message.mirrorAck);
        if (message.error) request.reject(new Error(String(message.error)));
        else request.resolve();
      } catch {
        /* Other page messages are unrelated to replay acknowledgements. */
      }
    },
    [browserId],
  );
  return (
    <View style={styles.container}>
      <PaneContentToolbar>
        <ToolbarButton label="Back" disabled={!browser?.canGoBack} onPress={goBack}>
          <ArrowLeft size={16} color={styles.icon.color} />
        </ToolbarButton>
        <ToolbarButton label="Forward" disabled={!browser?.canGoForward} onPress={goForward}>
          <ArrowRight size={16} color={styles.icon.color} />
        </ToolbarButton>
        <ToolbarButton label="Reload" onPress={reload}>
          <RotateCw size={16} color={styles.icon.color} />
        </ToolbarButton>
        <AdaptiveTextInput
          accessibilityLabel="Browser URL"
          style={styles.address}
          initialValue={browser?.url ?? sourceUrl}
          resetKey={browser?.url ?? sourceUrl}
          onChangeText={setDraftUrl}
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={navigate}
        />
      </PaneContentToolbar>
      {browser?.lastError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {browser.lastError}
        </Text>
      ) : null}
      <View style={styles.container} pointerEvents={isBrowserRunLocked(activity) ? "none" : "auto"}>
        <WebView
          ref={webview}
          source={source}
          style={styles.container}
          injectedJavaScript={`${capture};true;`}
          onLoadStart={handleLoadStart}
          onLoad={handleLoad}
          onError={handleError}
          onNavigationStateChange={handleNavigation}
          onTouchStart={onFocusPane}
          onMessage={handleMessage}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1 },
  icon: { color: theme.colors.foregroundMuted },
  address: { flex: 1, minWidth: 0, color: theme.colors.foreground },
  error: { color: theme.colors.destructive, padding: 8 },
}));
