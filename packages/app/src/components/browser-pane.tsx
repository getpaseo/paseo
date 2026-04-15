/**
 * BrowserPane — renders a browser view controlled by the daemon's BrowserManager.
 *
 * Phase 1: Displays screenshots streamed from the daemon via WebSocket.
 * The agent controls the browser through MCP tools (browser_navigate, browser_click, etc.)
 * and this pane reflects the current state.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  type LayoutChangeEvent,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { ArrowLeft, ArrowRight, Globe, RefreshCw } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

interface BrowserPaneProps {
  serverId: string;
  cwd: string;
  browserId: string;
  isPaneFocused: boolean;
}

interface BrowserState {
  url: string;
  title: string;
  screenshotData: string | null;
  screenshotMimeType: string;
  loading: boolean;
  error: string | null;
}

export function BrowserPane({ serverId, cwd, browserId, isPaneFocused }: BrowserPaneProps) {
  const { theme } = useUnistyles();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);

  const [browserState, setBrowserState] = useState<BrowserState>({
    url: "",
    title: "",
    screenshotData: null,
    screenshotMimeType: "image/jpeg",
    loading: true,
    error: null,
  });

  const [urlInput, setUrlInput] = useState("");
  const [isUrlFocused, setIsUrlFocused] = useState(false);
  const urlInputRef = useRef<TextInput>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleContentLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { width, height } = event.nativeEvent.layout;
      const w = Math.round(width);
      const h = Math.round(height);
      if (!client || !browserId || w < 10 || h < 10) return;

      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = setTimeout(() => {
        void client.browserResize(browserId, w, h);
      }, 150);
    },
    [browserId, client],
  );

  // Cleanup resize timer on unmount
  useEffect(() => {
    return () => {
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    };
  }, []);

  // Sync URL input with current browser URL (when not editing)
  useEffect(() => {
    if (!isUrlFocused) {
      setUrlInput(browserState.url);
    }
  }, [browserState.url, isUrlFocused]);

  // Poll for browser state + screenshots
  useEffect(() => {
    if (!client || !isConnected || !browserId) return;

    let cancelled = false;

    const fetchState = async () => {
      if (cancelled) return;
      try {
        const state = await client.getBrowserState(browserId);
        if (cancelled) return;
        setBrowserState((prev) => ({
          ...prev,
          url: state.url,
          title: state.title,
          loading: false,
          error: null,
        }));
      } catch {
        // Browser might not be ready yet
      }
    };

    const fetchScreenshot = async () => {
      if (cancelled) return;
      try {
        const shot = await client.getBrowserScreenshot(browserId);
        if (cancelled) return;
        setBrowserState((prev) => ({
          ...prev,
          screenshotData: shot.data,
          screenshotMimeType: shot.mimeType,
          loading: false,
        }));
      } catch {
        // Screenshot not available yet
      }
    };

    // Initial fetch
    void fetchState();
    void fetchScreenshot();

    // Poll every 2 seconds
    pollIntervalRef.current = setInterval(() => {
      void fetchState();
      void fetchScreenshot();
    }, 2000);

    return () => {
      cancelled = true;
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [browserId, client, isConnected]);

  const handleNavigate = useCallback(
    async (url: string) => {
      if (!client || !url.trim()) return;
      const normalizedUrl =
        url.startsWith("http://") || url.startsWith("https://") ? url : `https://${url}`;

      setBrowserState((prev) => ({ ...prev, loading: true }));
      try {
        const result = await client.browserNavigate(browserId, normalizedUrl);
        setBrowserState((prev) => ({
          ...prev,
          url: result.url,
          title: result.title,
          loading: false,
        }));
        // Fetch fresh screenshot after navigation
        const shot = await client.getBrowserScreenshot(browserId);
        setBrowserState((prev) => ({
          ...prev,
          screenshotData: shot.data,
          screenshotMimeType: shot.mimeType,
        }));
      } catch (err) {
        setBrowserState((prev) => ({
          ...prev,
          loading: false,
          error: err instanceof Error ? err.message : "Navigation failed",
        }));
      }
    },
    [browserId, client],
  );

  const handleGoBack = useCallback(async () => {
    if (!client) return;
    try {
      const result = await client.browserGoBack(browserId);
      setBrowserState((prev) => ({ ...prev, url: result.url, title: result.title }));
    } catch {
      // Ignore
    }
  }, [browserId, client]);

  const handleGoForward = useCallback(async () => {
    if (!client) return;
    try {
      const result = await client.browserGoForward(browserId);
      setBrowserState((prev) => ({ ...prev, url: result.url, title: result.title }));
    } catch {
      // Ignore
    }
  }, [browserId, client]);

  const handleRefresh = useCallback(async () => {
    if (!client || !browserState.url) return;
    void handleNavigate(browserState.url);
  }, [browserState.url, client, handleNavigate]);

  const handleUrlSubmit = useCallback(() => {
    urlInputRef.current?.blur();
    void handleNavigate(urlInput);
  }, [handleNavigate, urlInput]);

  const screenshotUri = useMemo(() => {
    if (!browserState.screenshotData) return null;
    return `data:${browserState.screenshotMimeType};base64,${browserState.screenshotData}`;
  }, [browserState.screenshotData, browserState.screenshotMimeType]);

  return (
    <View style={styles.container}>
      {/* Navigation bar */}
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
            style={styles.urlInput}
            autoCapitalize="none"
            autoCorrect={false}
            selectTextOnFocus
          />
          {browserState.loading && <ActivityIndicator size={10} color={theme.colors.accent} />}
        </View>
      </View>

      {/* Page title */}
      {browserState.title ? (
        <View style={styles.titleBar}>
          <Text style={styles.titleText} numberOfLines={1}>
            {browserState.title}
          </Text>
        </View>
      ) : null}

      {/* Content area — screenshot view */}
      <View style={styles.content} onLayout={handleContentLayout}>
        {browserState.error ? (
          <View style={styles.centerMessage}>
            <Text style={styles.errorText}>{browserState.error}</Text>
          </View>
        ) : screenshotUri ? (
          <Image source={{ uri: screenshotUri }} style={styles.screenshot} resizeMode="contain" />
        ) : browserState.loading ? (
          <View style={styles.centerMessage}>
            <ActivityIndicator size="large" color={theme.colors.accent} />
            <Text style={styles.loadingText}>Waiting for browser...</Text>
            <Text style={styles.hintText}>The agent will control this browser via MCP tools</Text>
          </View>
        ) : (
          <View style={styles.centerMessage}>
            <Globe size={48} color={theme.colors.surface3} strokeWidth={1.2} />
            <Text style={styles.emptyTitle}>Browser Ready</Text>
            <Text style={styles.hintText}>Enter a URL above or let the agent navigate</Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },

  // Navigation bar
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
  } as any,

  // Title bar
  titleBar: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 3,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surface2,
    backgroundColor: theme.colors.surface1,
  },
  titleText: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
  },

  // Content
  content: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  screenshot: {
    flex: 1,
    width: "100%",
  },
  centerMessage: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[6],
  },
  loadingText: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  emptyTitle: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  hintText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
  errorText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.destructive,
    textAlign: "center",
  },
}));
