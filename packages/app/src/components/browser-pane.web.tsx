import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  createElement,
} from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { ArrowLeft, ArrowRight, Globe, MousePointer2, RefreshCw, Search } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { isElectronRuntime } from "@/desktop/host";
import { useBrowserStore, normalizeWorkspaceBrowserUrl } from "@/stores/browser-store";
import { insertBrowserElementContext, type BrowserElementSelection } from "@/stores/browser-element-selection";

type ElectronWebview = HTMLElement & {
  canGoBack?: () => boolean;
  canGoForward?: () => boolean;
  goBack?: () => void;
  goForward?: () => void;
  reload?: () => void;
  stop?: () => void;
  loadURL?: (url: string) => void;
  getURL?: () => string;
  openDevTools?: () => void;
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
  removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
};

export function BrowserPane({ browserId }: { browserId: string }) {
  const { theme } = useUnistyles();
  const browser = useBrowserStore((state) => state.browsersById[browserId] ?? null);
  const updateBrowser = useBrowserStore((state) => state.updateBrowser);
  const webviewRef = useRef<ElectronWebview | null>(null);
  const webviewHostRef = useRef<HTMLDivElement | null>(null);
  const initialUrlRef = useRef(browser?.url ?? "https://example.com");
  const browserIdRef = useRef(browserId);
  browserIdRef.current = browserId;
  const domReadyRef = useRef(false);
  const [selectorActive, setSelectorActive] = useState(false);
  const [draftUrl, setDraftUrl] = useState(browser?.url ?? "https://example.com");

  useEffect(() => {
    const nextUrl = browser?.url ?? "https://example.com";
    setDraftUrl((current) => (current === nextUrl ? current : nextUrl));
  }, [browser?.url]);

  const updateBrowserRef = useRef(updateBrowser);
  updateBrowserRef.current = updateBrowser;

  const syncNavigationState = useCallback(() => {
    const webview = webviewRef.current;
    if (!webview || !domReadyRef.current) {
      return;
    }

    try {
      const currentUrl = webview.getURL?.() ?? webview.getAttribute("src") ?? "";
      updateBrowserRef.current(browserIdRef.current, {
        url: normalizeWorkspaceBrowserUrl(currentUrl),
        canGoBack: webview.canGoBack?.() ?? false,
        canGoForward: webview.canGoForward?.() ?? false,
      });
    } catch {
      // webview not yet attached
    }
  }, []);

  useEffect(() => {
    if (!isElectronRuntime()) {
      return;
    }

    const host = webviewHostRef.current;
    if (!host) {
      return;
    }

    host.replaceChildren();

    const webview = document.createElement("webview") as ElectronWebview;
    webviewRef.current = webview;
    webview.setAttribute("partition", `persist:paseo-browser-${browserId}`);
    webview.setAttribute("allowpopups", "true");
    webview.setAttribute("spellcheck", "false");
    webview.setAttribute("autosize", "on");
    webview.setAttribute("src", initialUrlRef.current);
    webview.style.display = "flex";
    webview.style.flex = "1";
    webview.style.width = "100%";
    webview.style.height = "100%";
    webview.style.border = "0";
    webview.style.background = "transparent";

    const handleStartLoading = () => {
      updateBrowser(browserId, { isLoading: true, lastError: null });
      syncNavigationState();
    };
    const handleStopLoading = () => {
      updateBrowser(browserId, { isLoading: false, lastError: null });
      syncNavigationState();
    };
    const handleNavigate = (event: Event) => {
      const nextUrl =
        typeof (event as Event & { url?: unknown }).url === "string"
          ? ((event as Event & { url?: string }).url ?? "")
          : webview.getURL?.() ?? webview.getAttribute("src") ?? "";
      updateBrowser(browserIdRef.current, {
        url: normalizeWorkspaceBrowserUrl(nextUrl),
        lastError: null,
      });
      setDraftUrl((current) => {
        const normalized = normalizeWorkspaceBrowserUrl(nextUrl);
        return current === normalized ? current : normalized;
      });
      syncNavigationState();
    };
    const handleTitleUpdated = (event: Event) => {
      const title =
        typeof (event as Event & { title?: unknown }).title === "string"
          ? ((event as Event & { title?: string }).title ?? "")
          : "";
      updateBrowserRef.current(browserIdRef.current, { title });
    };
    const handleFaviconUpdated = (event: Event) => {
      const favicons = Array.isArray((event as Event & { favicons?: unknown[] }).favicons)
        ? (((event as Event & { favicons?: string[] }).favicons as string[] | undefined) ?? [])
        : [];
      updateBrowserRef.current(browserIdRef.current, { faviconUrl: favicons[0] ?? null });
    };
    const handleLoadFailed = (event: Event) => {
      const errorDescription =
        typeof (event as Event & { errorDescription?: unknown }).errorDescription === "string"
          ? ((event as Event & { errorDescription?: string }).errorDescription ?? "")
          : "Failed to load page";
      updateBrowserRef.current(browserIdRef.current, {
        isLoading: false,
        lastError: errorDescription,
      });
    };
    const handleDomReady = () => {
      domReadyRef.current = true;
      updateBrowserRef.current(browserIdRef.current, { isLoading: false });
      syncNavigationState();
    };

    webview.addEventListener("did-start-loading", handleStartLoading);
    webview.addEventListener("did-stop-loading", handleStopLoading);
    webview.addEventListener("did-navigate", handleNavigate);
    webview.addEventListener("did-navigate-in-page", handleNavigate);
    webview.addEventListener("page-title-updated", handleTitleUpdated);
    webview.addEventListener("page-favicon-updated", handleFaviconUpdated);
    webview.addEventListener("did-fail-load", handleLoadFailed);
    webview.addEventListener("dom-ready", handleDomReady);

    host.appendChild(webview);

    return () => {
      webview.removeEventListener("did-start-loading", handleStartLoading);
      webview.removeEventListener("did-stop-loading", handleStopLoading);
      webview.removeEventListener("did-navigate", handleNavigate);
      webview.removeEventListener("did-navigate-in-page", handleNavigate);
      webview.removeEventListener("page-title-updated", handleTitleUpdated);
      webview.removeEventListener("page-favicon-updated", handleFaviconUpdated);
      webview.removeEventListener("did-fail-load", handleLoadFailed);
      webview.removeEventListener("dom-ready", handleDomReady);
      if (host.contains(webview)) {
        host.removeChild(webview);
      }
      if (webviewRef.current === webview) {
        webviewRef.current = null;
      }
      domReadyRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browserId]);

  const navigate = useCallback(
    (nextUrl: string) => {
      const normalizedUrl = normalizeWorkspaceBrowserUrl(nextUrl);
      const webview = webviewRef.current;
      updateBrowserRef.current(browserIdRef.current, {
        url: normalizedUrl,
        isLoading: true,
        lastError: null,
      });
      setDraftUrl((current) => (current === normalizedUrl ? current : normalizedUrl));
      if (webview?.loadURL) {
        webview.loadURL(normalizedUrl);
        return;
      }
      if (webview) {
        webview.setAttribute("src", normalizedUrl);
      }
    },
    [],
  );

  const startElementSelector = useCallback(() => {
    const webview = webviewRef.current;
    if (!webview || !domReadyRef.current) return;
    setSelectorActive(true);

    const js = `
      (function() {
        if (window.__paseoSelector) { window.__paseoSelector.destroy(); }
        var overlay = null;
        var style = document.createElement('style');
        style.textContent = [
          '.__paseo-hover { outline: 2px solid #3b82f6 !important; outline-offset: 2px !important; cursor: crosshair !important; }',
          '.__paseo-select-mode, .__paseo-select-mode * { cursor: crosshair !important; pointer-events: auto !important; user-select: none !important; }',
          '.__paseo-select-mode *, .__paseo-select-mode *::before, .__paseo-select-mode *::after { animation: none !important; transition: none !important; }',
          '.__paseo-select-mode a, .__paseo-select-mode button, .__paseo-select-mode input, .__paseo-select-mode select, .__paseo-select-mode textarea, .__paseo-select-mode [role="button"], .__paseo-select-mode [onclick] { pointer-events: none !important; }',
          '.__paseo-select-mode iframe, .__paseo-select-mode video, .__paseo-select-mode audio { pointer-events: none !important; }',
        ].join('\\n');
        document.head.appendChild(style);
        document.documentElement.classList.add('__paseo-select-mode');
        var last = null;
        function onMove(e) {
          e.preventDefault();
          e.stopPropagation();
          if (last) last.classList.remove('__paseo-hover');
          e.target.classList.add('__paseo-hover');
          last = e.target;
        }
        function buildSelector(el) {
          if (el.id) return '#' + el.id;
          var path = [];
          while (el && el.nodeType === 1) {
            var seg = el.tagName.toLowerCase();
            if (el.id) { path.unshift('#' + el.id); break; }
            var sib = el, nth = 1;
            while (sib = sib.previousElementSibling) { if (sib.tagName === el.tagName) nth++; }
            if (nth > 1) seg += ':nth-of-type(' + nth + ')';
            path.unshift(seg);
            el = el.parentElement;
          }
          return path.join(' > ');
        }
        function getReactSource(el) {
          var keys = Object.keys(el);
          for (var i = 0; i < keys.length; i++) {
            if (keys[i].startsWith('__reactFiber$') || keys[i].startsWith('__reactInternalInstance$')) {
              var fiber = el[keys[i]];
              while (fiber) {
                if (fiber._debugSource) {
                  return {
                    fileName: fiber._debugSource.fileName || null,
                    lineNumber: fiber._debugSource.lineNumber || null,
                    columnNumber: fiber._debugSource.columnNumber || null,
                    componentName: (fiber.type && (typeof fiber.type === 'string' ? fiber.type : fiber.type.displayName || fiber.type.name)) || null
                  };
                }
                if (fiber._debugOwner) { fiber = fiber._debugOwner; }
                else if (fiber.return) { fiber = fiber.return; }
                else break;
              }
            }
          }
          return null;
        }
        function getParentChain(el, depth) {
          var chain = [];
          var cur = el.parentElement;
          for (var i = 0; i < (depth || 5) && cur; i++) {
            var desc = cur.tagName.toLowerCase();
            if (cur.id) desc += '#' + cur.id;
            if (cur.className && typeof cur.className === 'string') { var cls = cur.className.trim().replace(/  +/g, ' ').split(' ').slice(0,2).join('.'); if (cls) desc += '.' + cls; }
            chain.push(desc);
            cur = cur.parentElement;
          }
          return chain;
        }
        function getChildSummary(el, max) {
          var kids = [];
          for (var i = 0; i < Math.min(el.children.length, max || 8); i++) {
            var c = el.children[i];
            var desc = c.tagName.toLowerCase();
            if (c.id) desc += '#' + c.id;
            kids.push(desc);
          }
          if (el.children.length > (max || 8)) kids.push('...(' + el.children.length + ' total)');
          return kids;
        }
        function getRelevantStyles(el) {
          var cs = window.getComputedStyle(el);
          var pick = ['display','position','width','height','color','background-color','font-size','font-family','padding','margin','border','flex','grid-template-columns','gap','overflow','opacity','z-index'];
          var out = {};
          pick.forEach(function(p) {
            var v = cs.getPropertyValue(p);
            if (v && v !== 'none' && v !== 'normal' && v !== 'auto' && v !== '0px' && v !== 'rgba(0, 0, 0, 0)') out[p] = v;
          });
          return out;
        }
        function onClick(e) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          var el = e.target;
          if (last) last.classList.remove('__paseo-hover');
          var attrs = {};
          for (var i = 0; i < el.attributes.length; i++) {
            attrs[el.attributes[i].name] = el.attributes[i].value;
          }
          var rect = el.getBoundingClientRect();
          var result = {
            tag: el.tagName.toLowerCase(),
            text: (el.innerText || '').substring(0, 500),
            selector: buildSelector(el),
            attributes: attrs,
            url: location.href,
            outerHTML: el.outerHTML.substring(0, 2000),
            computedStyles: getRelevantStyles(el),
            boundingRect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
            reactSource: getReactSource(el),
            parentChain: getParentChain(el, 5),
            children: getChildSummary(el, 8)
          };
          destroy();
          window.__paseoSelectorResult = result;
        }
        function onKey(e) {
          if (e.key === 'Escape') { destroy(); window.__paseoSelectorResult = { __cancelled: true }; }
        }
        function blockEvent(e) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
        }
        function destroy() {
          document.removeEventListener('mousemove', onMove, true);
          document.removeEventListener('click', onClick, true);
          document.removeEventListener('keydown', onKey, true);
          document.removeEventListener('mousedown', blockEvent, true);
          document.removeEventListener('mouseup', blockEvent, true);
          document.removeEventListener('pointerdown', blockEvent, true);
          document.removeEventListener('pointerup', blockEvent, true);
          document.removeEventListener('touchstart', blockEvent, true);
          document.removeEventListener('touchend', blockEvent, true);
          document.removeEventListener('focus', blockEvent, true);
          document.removeEventListener('submit', blockEvent, true);
          document.documentElement.classList.remove('__paseo-select-mode');
          if (last) last.classList.remove('__paseo-hover');
          style.remove();
          window.__paseoSelector = null;
        }
        document.addEventListener('mousemove', onMove, true);
        document.addEventListener('click', onClick, true);
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('mousedown', blockEvent, true);
        document.addEventListener('mouseup', blockEvent, true);
        document.addEventListener('pointerdown', blockEvent, true);
        document.addEventListener('pointerup', blockEvent, true);
        document.addEventListener('touchstart', blockEvent, true);
        document.addEventListener('touchend', blockEvent, true);
        document.addEventListener('focus', blockEvent, true);
        document.addEventListener('submit', blockEvent, true);
        window.__paseoSelector = { destroy: destroy };
      })()
    `;

    try {
      (webview as any).executeJavaScript(js).then(() => {
        // Poll for result
        const poll = setInterval(() => {
          (webview as any).executeJavaScript('JSON.stringify(window.__paseoSelectorResult || null)')
            .then((raw: string) => {
              const result = JSON.parse(raw);
              if (result) {
                clearInterval(poll);
                setSelectorActive(false);
                (webview as any).executeJavaScript('window.__paseoSelectorResult = null;');
                if (!result.__cancelled) {
                  void insertBrowserElementContext(browserIdRef.current, result as BrowserElementSelection);
                }
              }
            })
            .catch(() => {});
        }, 200);
        // Auto-cancel after 30s
        setTimeout(() => {
          clearInterval(poll);
          setSelectorActive(false);
          try {
            (webview as any).executeJavaScript('if(window.__paseoSelector) window.__paseoSelector.destroy();');
          } catch {}
        }, 30000);
      });
    } catch {
      setSelectorActive(false);
    }
  }, []);

  const cancelElementSelector = useCallback(() => {
    const webview = webviewRef.current;
    setSelectorActive(false);
    if (webview && domReadyRef.current) {
      try {
        (webview as any).executeJavaScript('if(window.__paseoSelector) window.__paseoSelector.destroy(); window.__paseoSelectorResult = null;');
      } catch {}
    }
  }, []);

  const webviewHostStyle = useMemo<CSSProperties>(
    () => ({
      display: "flex",
      flex: 1,
      width: "100%",
      height: "100%",
      minHeight: 0,
      background: theme.colors.surface0,
    }),
    [theme.colors.surface0],
  );

  if (!isElectronRuntime()) {
    return (
      <View style={styles.unavailableState}>
        <Text style={[styles.unavailableTitle, { color: theme.colors.foreground }]}>Browser is desktop-only</Text>
        <Text style={[styles.unavailableSubtitle, { color: theme.colors.foregroundMuted }]}>Open this workspace in Electron to use the built-in browser.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.chromeRow}>
        <View style={styles.chromeLeft}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back"
            disabled={!browser?.canGoBack}
            onPress={() => {
              webviewRef.current?.goBack?.();
              syncNavigationState();
            }}
            style={({ hovered, pressed }) => [
              styles.iconButton,
              (hovered || pressed) && styles.iconButtonHovered,
              !browser?.canGoBack && styles.iconButtonDisabled,
            ]}
          >
            <ArrowLeft size={16} color={theme.colors.foregroundMuted} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Forward"
            disabled={!browser?.canGoForward}
            onPress={() => {
              webviewRef.current?.goForward?.();
              syncNavigationState();
            }}
            style={({ hovered, pressed }) => [
              styles.iconButton,
              (hovered || pressed) && styles.iconButtonHovered,
              !browser?.canGoForward && styles.iconButtonDisabled,
            ]}
          >
            <ArrowRight size={16} color={theme.colors.foregroundMuted} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={browser?.isLoading ? "Stop loading" : "Refresh"}
            onPress={() => {
              if (browser?.isLoading) {
                webviewRef.current?.stop?.();
                updateBrowser(browserId, { isLoading: false });
                return;
              }
              webviewRef.current?.reload?.();
            }}
            style={({ hovered, pressed }) => [
              styles.iconButton,
              (hovered || pressed) && styles.iconButtonHovered,
            ]}
          >
            <RefreshCw size={16} color={theme.colors.foregroundMuted} />
          </Pressable>
        </View>
        <View style={styles.urlBarWrap}>
          <View style={styles.urlBarIconWrap}>
            {browser?.faviconUrl ? (
              createElement("img", {
                alt: "",
                src: browser.faviconUrl,
                style: { width: 14, height: 14, borderRadius: 3 } satisfies CSSProperties,
              })
            ) : (
              <Globe size={14} color={theme.colors.foregroundMuted} />
            )}
          </View>
          <TextInput
            accessibilityLabel="Browser URL"
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={setDraftUrl}
            onSubmitEditing={() => navigate(draftUrl)}
            placeholder="Enter URL"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={[
              styles.urlInput,
              {
                color: theme.colors.foreground,
                outlineStyle: "none",
              } as any,
            ]}
            value={draftUrl}
          />
        </View>
        <View style={styles.chromeRight}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Go to URL"
            onPress={() => navigate(draftUrl)}
            style={({ hovered, pressed }) => [
              styles.iconButton,
              (hovered || pressed) && styles.iconButtonHovered,
            ]}
          >
            <Search size={16} color={theme.colors.foregroundMuted} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={selectorActive ? "Cancel element selector" : "Select element"}
            onPress={() => {
              if (selectorActive) {
                cancelElementSelector();
              } else {
                startElementSelector();
              }
            }}
            style={({ hovered, pressed }) => [
              styles.iconButton,
              selectorActive && styles.selectorActiveButton,
              (hovered || pressed) && styles.iconButtonHovered,
            ]}
          >
            <MousePointer2 size={16} color={selectorActive ? theme.colors.accent : theme.colors.foregroundMuted} />
          </Pressable>
        </View>
      </View>
      {browser?.lastError ? (
        <View style={styles.errorRow}>
          <Text numberOfLines={1} style={[styles.metaError, { color: theme.colors.palette.red[500] }]}>
            {browser.lastError}
          </Text>
        </View>
      ) : null}
      <View style={styles.webviewWrap}>
        {createElement("div", {
          ref: (node: HTMLDivElement | null) => {
            webviewHostRef.current = node;
          },
          style: webviewHostStyle,
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  chromeRow: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surface3,
    backgroundColor: theme.colors.surface1,
  },
  chromeLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  chromeRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  iconButton: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  selectorActiveButton: {
    backgroundColor: `${String(theme.colors.accent)}20`,
  },
  iconButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  iconButtonDisabled: {
    opacity: 0.45,
  },
  urlBarWrap: {
    flex: 1,
    minWidth: 0,
    height: 30,
    borderRadius: 10,
    paddingLeft: 10,
    paddingRight: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: theme.colors.surface0,
    borderWidth: 1,
    borderColor: theme.colors.surface3,
  },
  urlBarIconWrap: {
    width: 14,
    height: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  urlInput: {
    flex: 1,
    minWidth: 0,
    fontSize: 12,
    paddingVertical: 0,
    paddingHorizontal: 0,
  },
  errorRow: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surface3,
    backgroundColor: theme.colors.surface0,
  },
  metaError: {
    fontSize: 11,
  },
  webviewWrap: {
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
  },
  unavailableState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 8,
  },
  unavailableTitle: {
    fontSize: 16,
    fontWeight: "600",
  },
  unavailableSubtitle: {
    fontSize: 12,
  },
}));
