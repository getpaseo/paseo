// @ts-nocheck
/**
 * BrowserPane (Web/Electron) — visual placeholder for an Electron
 * `WebContentsView` that lives in the main process.
 *
 * Why `WebContentsView` and not the old `<webview>` tag: `<webview>`
 * contents are NOT exposed by Electron's `--remote-debugging-port`,
 * which means Playwright's `chromium.connectOverCDP` cannot drive
 * them. A `WebContentsView` attached to the BrowserWindow is a proper
 * CDP target, so the daemon's PlaywrightBrowserManager sees and
 * controls it with the full Page API.
 *
 * Because `WebContentsView` is an OS-level overlay — not a DOM node —
 * this React component doesn't render the browser itself. It renders
 * the navigation chrome (back/forward/reload, URL bar) + a sized
 * placeholder `<div>`. On every layout change we tell the main process
 * the pane's current screen-space rect so the OS overlay lines up
 * exactly where the placeholder is. Navigate/back/forward/URL state
 * all flow through IPC to the main process.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, TextInput, View } from "react-native";
import { ArrowLeft, ArrowRight, Globe, RefreshCw, ExternalLink } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { getIsElectron } from "@/constants/platform";
import { openExternalUrl } from "@/utils/open-external-url";
import { clearBrowserRect, setBrowserRect } from "@/stores/browser-bounds-store";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

interface BrowserPaneProps {
  serverId: string;
  cwd: string;
  browserId: string;
  isPaneFocused: boolean;
  initialUrl?: string;
}

function getBridge(): any {
  if (typeof window === "undefined") return null;
  return (window as any).hubcodeDesktop?.browserView ?? null;
}

export function BrowserPane({ serverId, browserId, initialUrl }: BrowserPaneProps) {
  "use no memo";
  const { theme } = useUnistyles();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const urlInputRef = useRef<TextInput>(null);
  const isElectron = getIsElectron();
  const bridge = getBridge();
  // Viewer mode: no native WebContentsView available (web visitor in a
  // shared session). Subscribe to CDP screencast frames from the daemon
  // and render the latest JPEG frame.
  const isViewerMode = !isElectron || !bridge;
  const client = useHostRuntimeClient(serverId);
  const [frameDataUrl, setFrameDataUrl] = useState<string | null>(null);
  // Dimensions reported by CDP on each screencast frame — used to map
  // the visitor's pointer coords (in displayed-img space) to CSS pixel
  // coords in the host viewport for Input.dispatchMouseEvent.
  const frameSizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  const imgRef = useRef<HTMLImageElement | null>(null);

  const [currentUrl, setCurrentUrl] = useState(initialUrl || "about:blank");
  const [urlInput, setUrlInput] = useState(initialUrl || "");
  const [isUrlFocused, setIsUrlFocused] = useState(false);
  const [isLoading, setIsLoading] = useState(!!initialUrl);

  useEffect(() => {
    if (!isUrlFocused) {
      setUrlInput(currentUrl === "about:blank" ? "" : currentUrl);
    }
  }, [currentUrl, isUrlFocused]);

  // Create + subscribe to state updates from the main-process view.
  useEffect(() => {
    if (!isElectron || !bridge) return;
    console.log("[BrowserPane] create WebContentsView for", browserId);
    void bridge.create({ browserId, url: initialUrl });
    const unsub = bridge.onState((payload: any) => {
      if (payload?.browserId !== browserId) return;
      if (typeof payload.url === "string") setCurrentUrl(payload.url);
      if (typeof payload.isLoading === "boolean") setIsLoading(payload.isLoading);
    });
    return () => {
      try {
        unsub?.();
      } catch {}
      // Destroy the view when this pane unmounts so we don't leak
      // Chromium processes across tab close / workspace switch.
      void bridge.destroy({ browserId }).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browserId, isElectron]);

  // Track the placeholder's screen rect and push it to the main
  // process whenever it changes (window resize, split drag, tab
  // switch, etc.). The WebContentsView is an OS overlay, so without
  // this it would sit at the wrong spot on screen.
  useEffect(() => {
    if (!isElectron || !bridge || !containerRef.current) return;
    const el = containerRef.current;
    let lastKey = "";
    const pushBounds = () => {
      const r = el.getBoundingClientRect();
      const bounds = {
        browserId,
        x: r.left,
        y: r.top,
        width: r.width,
        height: r.height,
      };
      const key = `${Math.round(bounds.x)},${Math.round(bounds.y)},${Math.round(bounds.width)},${Math.round(bounds.height)}`;
      if (key === lastKey) return;
      lastKey = key;
      void bridge.setBounds(bounds);
      void bridge.setVisible({
        browserId,
        visible: bounds.width > 1 && bounds.height > 1,
      });
      setBrowserRect(browserId, {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      });
    };
    pushBounds();
    const ro = new ResizeObserver(() => {
      // Debounce to next frame so we coalesce resize bursts and avoid
      // the classic ResizeObserver → setState → resize loop.
      requestAnimationFrame(pushBounds);
    });
    ro.observe(el);
    window.addEventListener("resize", pushBounds);
    window.addEventListener("scroll", pushBounds, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", pushBounds);
      window.removeEventListener("scroll", pushBounds, true);
      clearBrowserRect(browserId);
    };
  }, [browserId, isElectron, bridge]);

  // Viewer-mode subscription: ask the daemon for screencast frames of the
  // host's browser and render them. Send the current URL as a lookup hint
  // so the visitor Session (which never called `launch()`) can still find
  // the matching Playwright page.
  useEffect(() => {
    if (!isViewerMode || !client) return;
    const urlHint = initialUrl || currentUrl;
    try {
      client.subscribeBrowserFrames(browserId, urlHint);
    } catch {}
    const off = client.on("browser_frame" as any, (msg: any) => {
      const p = msg?.payload;
      if (!p || p.browserId !== browserId) return;
      if (typeof p.data !== "string" || !p.data) return;
      if (typeof p.width === "number" && typeof p.height === "number") {
        frameSizeRef.current = { w: p.width, h: p.height };
      }
      setFrameDataUrl(`data:image/jpeg;base64,${p.data}`);
    });
    return () => {
      try {
        off?.();
      } catch {}
      try {
        client.unsubscribeBrowserFrames(browserId);
      } catch {}
    };
    // Only re-subscribe when the browser or client identity changes —
    // not on every URL change (daemon keeps streaming across navigations).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browserId, isViewerMode, client]);

  // Map a pointer event on the rendered img to host-viewport CSS pixel
  // coords. Returns null if we don't yet know the frame size.
  const mapEventToPageCoords = useCallback(
    (e: { clientX: number; clientY: number }): { x: number; y: number } | null => {
      const img = imgRef.current;
      const { w, h } = frameSizeRef.current;
      if (!img || !w || !h) return null;
      const r = img.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
      // `object-fit: contain` renders the img letterboxed — compute the
      // actual drawn content rect inside the element and clamp to it.
      const imgAspect = w / h;
      const elAspect = r.width / r.height;
      let drawW = r.width;
      let drawH = r.height;
      let drawLeft = r.left;
      let drawTop = r.top;
      if (elAspect > imgAspect) {
        drawW = r.height * imgAspect;
        drawLeft = r.left + (r.width - drawW) / 2;
      } else {
        drawH = r.width / imgAspect;
        drawTop = r.top + (r.height - drawH) / 2;
      }
      const fx = (e.clientX - drawLeft) / drawW;
      const fy = (e.clientY - drawTop) / drawH;
      if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
      return { x: Math.round(fx * w), y: Math.round(fy * h) };
    },
    [],
  );

  const modifiersForEvent = useCallback(
    (e: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }) =>
      (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0),
    [],
  );

  const buttonFromEvent = useCallback(
    (b: number): "left" | "right" | "middle" => (b === 2 ? "right" : b === 1 ? "middle" : "left"),
    [],
  );

  // Capture keyboard events at window level while the viewer img is
  // focused — cheaper than wrapping the img in a contentEditable. A
  // simple `focused` flag gates whether we actually forward.
  const [viewerFocused, setViewerFocused] = useState(false);
  useEffect(() => {
    if (!isViewerMode || !client || !viewerFocused) return;
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      // CDP's `text` field drives composition: send it only for keys
      // that produce a character, so arrows/Enter/etc still work as
      // control keys rather than being typed.
      const producesText = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
      client.sendBrowserInput({
        browserId,
        kind: "key_down",
        key: e.key,
        code: e.code,
        text: producesText ? e.key : undefined,
        modifiers: modifiersForEvent(e),
      });
    };
    const onKeyUp = (e: KeyboardEvent) => {
      e.preventDefault();
      client.sendBrowserInput({
        browserId,
        kind: "key_up",
        key: e.key,
        code: e.code,
        modifiers: modifiersForEvent(e),
      });
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [isViewerMode, client, viewerFocused, browserId, modifiersForEvent]);

  // Throttle mouse_move to ~30fps so we don't flood the WS.
  const lastMoveRef = useRef(0);

  const navigateTo = useCallback(
    (url: string) => {
      if (!url.trim() || !bridge) return;
      const normalizedUrl =
        url.startsWith("http://") || url.startsWith("https://") ? url : `https://${url}`;
      setCurrentUrl(normalizedUrl);
      setIsLoading(true);
      void bridge.loadUrl({ browserId, url: normalizedUrl }).catch(() => {});
    },
    [bridge, browserId],
  );

  const handleUrlSubmit = useCallback(() => {
    urlInputRef.current?.blur();
    navigateTo(urlInput);
  }, [navigateTo, urlInput]);

  const handleGoBack = useCallback(
    () => bridge?.nav({ browserId, action: "back" }),
    [bridge, browserId],
  );
  const handleGoForward = useCallback(
    () => bridge?.nav({ browserId, action: "forward" }),
    [bridge, browserId],
  );
  const handleRefresh = useCallback(
    () => bridge?.nav({ browserId, action: "reload" }),
    [bridge, browserId],
  );
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

      {/* Host: the real page renders in a native WebContentsView overlay
          positioned over this rect. Viewer: we render the CDP screencast
          frame the daemon streams so shared-session visitors see the
          host's browser even though they don't have the native overlay. */}
      <div
        ref={containerRef}
        style={{
          flex: 1,
          display: "flex",
          position: "relative",
          width: "100%",
          height: "100%",
          minHeight: 0,
          backgroundColor: "#0e0e0e",
          overflow: "hidden",
        }}
      >
        {isViewerMode && frameDataUrl && (
          <div
            tabIndex={0}
            onFocus={() => setViewerFocused(true)}
            onBlur={() => setViewerFocused(false)}
            onMouseMove={(e) => {
              if (!client) return;
              const now = performance.now();
              if (now - lastMoveRef.current < 33) return;
              lastMoveRef.current = now;
              const pt = mapEventToPageCoords(e);
              if (!pt) return;
              client.sendBrowserInput({
                browserId,
                kind: "mouse_move",
                x: pt.x,
                y: pt.y,
                modifiers: modifiersForEvent(e),
              });
            }}
            onMouseDown={(e) => {
              if (!client) return;
              const pt = mapEventToPageCoords(e);
              if (!pt) return;
              (e.currentTarget as HTMLDivElement).focus();
              client.sendBrowserInput({
                browserId,
                kind: "mouse_down",
                x: pt.x,
                y: pt.y,
                button: buttonFromEvent(e.button),
                clickCount: e.detail || 1,
                modifiers: modifiersForEvent(e),
              });
            }}
            onMouseUp={(e) => {
              if (!client) return;
              const pt = mapEventToPageCoords(e);
              if (!pt) return;
              client.sendBrowserInput({
                browserId,
                kind: "mouse_up",
                x: pt.x,
                y: pt.y,
                button: buttonFromEvent(e.button),
                clickCount: e.detail || 1,
                modifiers: modifiersForEvent(e),
              });
            }}
            onContextMenu={(e) => e.preventDefault()}
            onWheel={(e) => {
              if (!client) return;
              const pt = mapEventToPageCoords(e);
              if (!pt) return;
              client.sendBrowserInput({
                browserId,
                kind: "mouse_wheel",
                x: pt.x,
                y: pt.y,
                deltaX: e.deltaX,
                deltaY: e.deltaY,
                modifiers: modifiersForEvent(e),
              });
            }}
            style={{
              width: "100%",
              height: "100%",
              outline: "none",
              cursor: "default",
              display: "flex",
            }}
          >
            <img
              ref={imgRef}
              src={frameDataUrl}
              alt=""
              draggable={false}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "contain",
                userSelect: "none",
                pointerEvents: "none",
              }}
            />
          </div>
        )}
        {isViewerMode && !frameDataUrl && (
          <div
            style={{
              margin: "auto",
              color: "#a1a1aa",
              fontSize: 13,
              fontFamily:
                "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
            }}
          >
            Conectando ao browser do host…
          </div>
        )}
      </div>
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
