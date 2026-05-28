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
import { ArrowLeft, ArrowRight, MousePointer2, PencilRuler, RotateCw } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  buildWorkspaceAttachmentScopeKey,
  useWorkspaceAttachments,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import type { BrowserElementAttachment } from "@/attachments/types";
import { WORKSPACE_SECONDARY_HEADER_HEIGHT } from "@/constants/layout";
import {
  getDesktopHost,
  isElectronRuntime,
  type DesktopBrowserShortcutEvent,
} from "@/desktop/host";
import { isDev } from "@/constants/platform";
import { useBrowserStore, normalizeWorkspaceBrowserUrl } from "@/stores/browser-store";

type ElectronWebview = HTMLElement & {
  canGoBack?: () => boolean;
  canGoForward?: () => boolean;
  goBack?: () => void;
  goForward?: () => void;
  reload?: () => void;
  stop?: () => void;
  loadURL?: (url: string) => Promise<void>;
  getURL?: () => string;
  executeJavaScript?: (code: string) => Promise<unknown>;
  focus?: () => void;
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
  removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
};

type WebTextInput = TextInput & {
  getNativeRef?: () => unknown;
};

type BrowserElementSelection = Omit<BrowserElementAttachment, "formatted"> & {
  attributes?: Record<string, string>;
};

const ERR_ABORTED = -3;
const ALLOWED_BROWSER_PROTOCOLS = new Set(["http:", "https:"]);

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength).trim()}...` : value;
}

function getWebviewLoadErrorMessage(event: Event): string | null {
  const details = event as Event & {
    errorCode?: unknown;
    errorDescription?: unknown;
    isMainFrame?: unknown;
    validatedURL?: unknown;
  };
  if (details.isMainFrame === false || details.errorCode === ERR_ABORTED) {
    return null;
  }

  const description =
    typeof details.errorDescription === "string" && details.errorDescription.trim()
      ? details.errorDescription.trim()
      : "Failed to load page";
  const url =
    typeof details.validatedURL === "string" && details.validatedURL.trim()
      ? details.validatedURL.trim()
      : null;

  return url ? `${description}: ${url}` : description;
}

function getLoadUrlRejectionMessage(error: unknown): string | null {
  if (error instanceof Error && error.message.trim()) {
    if (error.message.includes("ERR_ABORTED") || error.message.includes("ERR_BLOCKED_BY_CLIENT")) {
      return null;
    }
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim()) {
    if (error.includes("ERR_ABORTED") || error.includes("ERR_BLOCKED_BY_CLIENT")) {
      return null;
    }
    return error.trim();
  }
  return "Failed to load page";
}

function getUnsafeNavigationMessage(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (ALLOWED_BROWSER_PROTOCOLS.has(parsed.protocol) || parsed.href === "about:blank") {
      return null;
    }
    return `Blocked unsupported browser URL: ${parsed.protocol}`;
  } catch {
    return "Invalid browser URL";
  }
}

function formatElementAttachment(selection: BrowserElementSelection): string {
  const textPreview = truncateText(selection.text.trim(), 200);
  const html = truncateText(selection.outerHTML.trim(), 800);
  const parts: string[] = [];

  if (selection.reactSource?.fileName) {
    const loc = [
      selection.reactSource.fileName,
      selection.reactSource.lineNumber != null ? `:${selection.reactSource.lineNumber}` : "",
      selection.reactSource.columnNumber != null ? `:${selection.reactSource.columnNumber}` : "",
    ].join("");
    parts.push(`source: ${selection.reactSource.componentName ?? selection.tag} @ ${loc}`);
  }

  parts.push(`selector: ${selection.selector}`);

  if (textPreview) {
    parts.push(`text: ${JSON.stringify(textPreview)}`);
  }

  parts.push(`size: ${selection.boundingRect.width}x${selection.boundingRect.height}`);

  const keyStyles = Object.entries(selection.computedStyles)
    .filter(([key]) =>
      ["display", "position", "font-size", "color", "background-color"].includes(key),
    )
    .map(([key, value]) => `${key}: ${value}`)
    .join("; ");
  if (keyStyles) {
    parts.push(`styles: ${keyStyles}`);
  }

  if (selection.parentChain.length > 0) {
    parts.push(`parents: ${selection.parentChain.slice(0, 3).join(" > ")}`);
  }

  return [
    `<browser-element url="${selection.url}">`,
    parts.map((part) => `  ${part}`).join("\n"),
    `  html: ${html}`,
    `</browser-element>`,
  ].join("\n");
}

function buildBrowserElementAttachment(
  selection: BrowserElementSelection,
): BrowserElementAttachment {
  return {
    url: selection.url,
    selector: selection.selector,
    tag: selection.tag,
    text: selection.text,
    outerHTML: truncateText(selection.outerHTML, 2000),
    computedStyles: selection.computedStyles,
    boundingRect: selection.boundingRect,
    reactSource: selection.reactSource,
    parentChain: selection.parentChain,
    children: selection.children,
    formatted: formatElementAttachment(selection),
  };
}

function buildBrowserAttachmentScopeKey(input: {
  cwd: string | null;
  serverId: string;
  workspaceId: string;
}): string | null {
  if (!input.cwd) {
    return null;
  }
  return buildWorkspaceAttachmentScopeKey({
    serverId: input.serverId,
    workspaceId: input.workspaceId,
    cwd: input.cwd,
  });
}

function executeWebviewJavaScript(webview: ElectronWebview, code: string): Promise<unknown> {
  if (!webview.isConnected) {
    return Promise.resolve(null);
  }
  try {
    return webview.executeJavaScript?.(code) ?? Promise.resolve(null);
  } catch (error) {
    return Promise.reject(error);
  }
}

function ignoreWebviewJavaScriptError() {}

function destroyWebviewSelector(webview: ElectronWebview): void {
  void executeWebviewJavaScript(
    webview,
    "if(window.__paseoSelector) window.__paseoSelector.destroy();",
  ).catch(ignoreWebviewJavaScriptError);
}

function clearWebviewSelector(webview: ElectronWebview): void {
  void executeWebviewJavaScript(
    webview,
    "if(window.__paseoSelector) window.__paseoSelector.destroy(); window.__paseoSelectorResult = null;",
  ).catch(ignoreWebviewJavaScriptError);
}

function getTextInputNativeElement(current: WebTextInput | null): HTMLInputElement | null {
  const native = current?.getNativeRef?.() ?? current;
  return native instanceof HTMLInputElement ? native : null;
}

function isBrowserShortcutKey(event: KeyboardEvent, key: "l" | "r"): boolean {
  if (event.altKey || event.shiftKey) {
    return false;
  }
  if (!event.metaKey && !event.ctrlKey) {
    return false;
  }
  const eventKey = event.key.toLowerCase();
  return eventKey === key || event.code === `Key${key.toUpperCase()}`;
}

function isDesktopBrowserShortcutEvent(payload: unknown): payload is DesktopBrowserShortcutEvent {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const event = payload as Partial<DesktopBrowserShortcutEvent>;
  return event.action === "focus-url";
}

function startSelectorResultPolling(input: {
  webview: ElectronWebview;
  onSelection: (selection: BrowserElementSelection) => void;
  onDone: () => void;
}): number {
  const { webview, onSelection, onDone } = input;
  const poll = window.setInterval(() => {
    void (async () => {
      try {
        const raw = await executeWebviewJavaScript(
          webview,
          "JSON.stringify(window.__paseoSelectorResult || null)",
        );
        const result = typeof raw === "string" ? JSON.parse(raw) : null;
        if (!result) {
          return;
        }
        window.clearInterval(poll);
        onDone();
        await executeWebviewJavaScript(webview, "window.__paseoSelectorResult = null;");
        if (!result.__cancelled) {
          onSelection(result as BrowserElementSelection);
        }
      } catch {
        // Keep polling; cross-origin/webview timing can make this transient.
      }
    })();
  }, 200);

  return poll;
}

// eslint-disable-next-line complexity
export function BrowserPane({
  browserId,
  serverId,
  workspaceId,
  cwd,
  isInteractive,
  onFocusPane,
}: {
  browserId: string;
  serverId: string;
  workspaceId: string;
  cwd: string | null;
  isInteractive?: boolean;
  onFocusPane?: () => void;
}) {
  const { theme } = useUnistyles();
  const browser = useBrowserStore((state) => state.browsersById[browserId] ?? null);
  const updateBrowser = useBrowserStore((state) => state.updateBrowser);
  const webviewRef = useRef<ElectronWebview | null>(null);
  const webviewHostRef = useRef<HTMLDivElement | null>(null);
  const urlInputRef = useRef<WebTextInput | null>(null);
  const initialUrlRef = useRef(browser?.url ?? "https://example.com");
  const browserIdRef = useRef(browserId);
  browserIdRef.current = browserId;
  const browserRef = useRef(browser);
  browserRef.current = browser;
  const pendingNavigationUrlRef = useRef<string | null>(null);
  const domReadyRef = useRef(false);
  const [selectorActive, setSelectorActive] = useState(false);
  const [draftUrl, setDraftUrl] = useState(browser?.url ?? "https://example.com");
  const workspaceAttachmentScopeKey = useMemo(
    () => buildBrowserAttachmentScopeKey({ cwd, serverId, workspaceId }),
    [cwd, serverId, workspaceId],
  );
  const workspaceAttachments = useWorkspaceAttachments(workspaceAttachmentScopeKey ?? "");
  const setWorkspaceAttachments = useWorkspaceAttachmentsStore(
    (state) => state.setWorkspaceAttachments,
  );
  const titleStyle = useMemo(
    () => [styles.unavailableTitle, { color: theme.colors.foreground }],
    [theme.colors.foreground],
  );
  const subtitleStyle = useMemo(
    () => [styles.unavailableSubtitle, { color: theme.colors.foregroundMuted }],
    [theme.colors.foregroundMuted],
  );
  const urlInputStyle = useMemo(
    () => [
      styles.urlInput,
      {
        color: theme.colors.foreground,
        outlineStyle: "none",
      } as object,
    ],
    [theme.colors.foreground],
  );
  const errorTextStyle = useMemo(
    () => [styles.metaError, { color: theme.colors.palette.red[500] }],
    [theme.colors.palette.red],
  );

  useEffect(() => {
    const nextUrl = browser?.url ?? "https://example.com";
    setDraftUrl((current) => (current === nextUrl ? current : nextUrl));
  }, [browser?.url]);

  const updateBrowserRef = useRef(updateBrowser);
  updateBrowserRef.current = updateBrowser;

  const selectUrlBar = useCallback(() => {
    window.setTimeout(() => {
      getTextInputNativeElement(urlInputRef.current)?.select();
    }, 0);
  }, []);

  const handleUrlBarFocus = useCallback(() => {
    selectUrlBar();
  }, [selectUrlBar]);

  const focusUrlBar = useCallback(() => {
    urlInputRef.current?.focus();
    selectUrlBar();
  }, [selectUrlBar]);

  const syncNavigationState = useCallback((input?: { syncUrl?: boolean }) => {
    const webview = webviewRef.current;
    if (!webview || !domReadyRef.current) {
      return;
    }

    try {
      const currentUrl = webview.getURL?.() ?? webview.getAttribute("src") ?? "";
      const patch = {
        canGoBack: webview.canGoBack?.() ?? false,
        canGoForward: webview.canGoForward?.() ?? false,
        ...(input?.syncUrl === false
          ? {}
          : { url: normalizeWorkspaceBrowserUrl(pendingNavigationUrlRef.current ?? currentUrl) }),
      };
      updateBrowserRef.current(browserIdRef.current, patch);
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

    const initialUnsafeNavigationMessage = getUnsafeNavigationMessage(initialUrlRef.current);
    const webview = document.createElement("webview") as ElectronWebview;
    webviewRef.current = webview;
    webview.setAttribute("partition", `persist:paseo-browser-${browserId}`);
    webview.setAttribute("allowpopups", "true");
    webview.setAttribute("spellcheck", "false");
    webview.setAttribute("autosize", "on");
    webview.setAttribute(
      "src",
      initialUnsafeNavigationMessage ? "about:blank" : initialUrlRef.current,
    );
    webview.style.display = "flex";
    webview.style.flex = "1";
    webview.style.width = "100%";
    webview.style.height = "100%";
    webview.style.border = "0";
    webview.style.background = "transparent";

    const handleStartLoading = () => {
      updateBrowser(browserId, { isLoading: true, lastError: null });
      syncNavigationState({ syncUrl: false });
    };
    const handleStopLoading = () => {
      updateBrowser(browserId, { isLoading: false });
      syncNavigationState();
    };
    const handleNavigate = (event: Event) => {
      const nextUrl =
        typeof (event as Event & { url?: unknown }).url === "string"
          ? ((event as Event & { url?: string }).url ?? "")
          : (webview.getURL?.() ?? webview.getAttribute("src") ?? "");
      const normalized = normalizeWorkspaceBrowserUrl(nextUrl);
      const previousUrl = browserRef.current?.url ?? initialUrlRef.current;
      pendingNavigationUrlRef.current = null;
      updateBrowser(browserIdRef.current, {
        url: normalized,
        ...(normalized !== previousUrl ? { faviconUrl: null } : {}),
        lastError: null,
      });
      setDraftUrl((current) => {
        return current === normalized ? current : normalized;
      });
      syncNavigationState();
    };
    const handleWillNavigate = (event: Event) => {
      const nextUrl =
        typeof (event as Event & { url?: unknown }).url === "string"
          ? ((event as Event & { url?: string }).url ?? "")
          : "";
      if (!nextUrl) {
        return;
      }
      const normalized = normalizeWorkspaceBrowserUrl(nextUrl);
      pendingNavigationUrlRef.current = normalized;
      updateBrowserRef.current(browserIdRef.current, {
        url: normalized,
        ...(normalized !== browserRef.current?.url ? { faviconUrl: null } : {}),
        lastError: null,
      });
      setDraftUrl((current) => (current === normalized ? current : normalized));
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
        ? ((event as Event & { favicons?: string[] }).favicons ?? [])
        : [];
      updateBrowserRef.current(browserIdRef.current, { faviconUrl: favicons[0] ?? null });
    };
    const handleLoadFailed = (event: Event) => {
      const message = getWebviewLoadErrorMessage(event);
      if (!message) {
        return;
      }
      updateBrowserRef.current(browserIdRef.current, {
        isLoading: false,
        lastError: message,
      });
    };
    const handleDomReady = () => {
      domReadyRef.current = true;
      syncNavigationState();
    };
    const handleWebviewFocus = () => {
      onFocusPane?.();
    };

    webview.addEventListener("did-start-loading", handleStartLoading);
    webview.addEventListener("did-stop-loading", handleStopLoading);
    webview.addEventListener("will-navigate", handleWillNavigate);
    webview.addEventListener("did-navigate", handleNavigate);
    webview.addEventListener("did-navigate-in-page", handleNavigate);
    webview.addEventListener("page-title-updated", handleTitleUpdated);
    webview.addEventListener("page-favicon-updated", handleFaviconUpdated);
    webview.addEventListener("did-fail-load", handleLoadFailed);
    webview.addEventListener("dom-ready", handleDomReady);
    webview.addEventListener("focus", handleWebviewFocus);
    webview.addEventListener("mousedown", handleWebviewFocus);

    host.appendChild(webview);
    if (initialUnsafeNavigationMessage) {
      updateBrowserRef.current(browserIdRef.current, {
        isLoading: false,
        lastError: initialUnsafeNavigationMessage,
      });
    }

    return () => {
      webview.removeEventListener("did-start-loading", handleStartLoading);
      webview.removeEventListener("did-stop-loading", handleStopLoading);
      webview.removeEventListener("will-navigate", handleWillNavigate);
      webview.removeEventListener("did-navigate", handleNavigate);
      webview.removeEventListener("did-navigate-in-page", handleNavigate);
      webview.removeEventListener("page-title-updated", handleTitleUpdated);
      webview.removeEventListener("page-favicon-updated", handleFaviconUpdated);
      webview.removeEventListener("did-fail-load", handleLoadFailed);
      webview.removeEventListener("dom-ready", handleDomReady);
      webview.removeEventListener("focus", handleWebviewFocus);
      webview.removeEventListener("mousedown", handleWebviewFocus);
      if (host.contains(webview)) {
        host.removeChild(webview);
      }
      if (webviewRef.current === webview) {
        webviewRef.current = null;
      }
      domReadyRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browserId, onFocusPane]);

  const navigate = useCallback((nextUrl: string) => {
    const normalizedUrl = normalizeWorkspaceBrowserUrl(nextUrl);
    const webview = webviewRef.current;
    const unsafeNavigationMessage = getUnsafeNavigationMessage(normalizedUrl);
    const previousUrl = browserRef.current?.url ?? initialUrlRef.current;
    pendingNavigationUrlRef.current = unsafeNavigationMessage ? null : normalizedUrl;
    updateBrowserRef.current(browserIdRef.current, {
      url: normalizedUrl,
      isLoading: unsafeNavigationMessage === null,
      ...(normalizedUrl !== previousUrl ? { faviconUrl: null } : {}),
      lastError: null,
    });
    setDraftUrl((current) => (current === normalizedUrl ? current : normalizedUrl));
    if (unsafeNavigationMessage) {
      updateBrowserRef.current(browserIdRef.current, {
        isLoading: false,
        lastError: unsafeNavigationMessage,
      });
      return;
    }
    if (webview?.loadURL) {
      void webview.loadURL(normalizedUrl).catch((error: unknown) => {
        const message = getLoadUrlRejectionMessage(error);
        if (!message) {
          return;
        }
        updateBrowserRef.current(browserIdRef.current, {
          isLoading: false,
          lastError: message,
        });
      });
      return;
    }
    if (webview) {
      webview.setAttribute("src", normalizedUrl);
    }
  }, []);

  const handleBack = useCallback(() => {
    webviewRef.current?.goBack?.();
    syncNavigationState();
  }, [syncNavigationState]);

  const handleForward = useCallback(() => {
    webviewRef.current?.goForward?.();
    syncNavigationState();
  }, [syncNavigationState]);

  const handleRefresh = useCallback(() => {
    if (browser?.isLoading) {
      webviewRef.current?.stop?.();
      updateBrowser(browserId, { isLoading: false });
      return;
    }
    webviewRef.current?.reload?.();
  }, [browser?.isLoading, browserId, updateBrowser]);

  useEffect(() => {
    if (!isElectronRuntime() || !isInteractive) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isBrowserShortcutKey(event, "l")) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        focusUrlBar();
        return;
      }
      if (isBrowserShortcutKey(event, "r")) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        handleRefresh();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [focusUrlBar, handleRefresh, isInteractive]);

  useEffect(() => {
    if (!isElectronRuntime()) {
      return;
    }
    const unsubscribe = getDesktopHost()?.events?.on?.("browser-shortcut", (payload) => {
      if (!isDesktopBrowserShortcutEvent(payload)) {
        return;
      }
      if (payload.browserId) {
        if (payload.browserId !== browserIdRef.current) {
          return;
        }
        focusUrlBar();
        return;
      }
      if (!isInteractive) {
        return;
      }
      focusUrlBar();
    });

    if (typeof unsubscribe === "function") {
      return unsubscribe;
    }
    return () => {
      void unsubscribe?.then((dispose) => dispose());
    };
  }, [focusUrlBar, isInteractive]);

  const handleNavigateDraftUrl = useCallback(() => {
    navigate(draftUrl);
  }, [draftUrl, navigate]);

  const addElementAttachment = useCallback(
    (selection: BrowserElementSelection) => {
      if (!workspaceAttachmentScopeKey) {
        return;
      }
      setWorkspaceAttachments({
        scopeKey: workspaceAttachmentScopeKey,
        attachments: [
          ...workspaceAttachments,
          {
            kind: "browser_element",
            attachment: buildBrowserElementAttachment(selection),
          },
        ],
      });
    },
    [setWorkspaceAttachments, workspaceAttachmentScopeKey, workspaceAttachments],
  );

  const startElementSelector = useCallback(() => {
    const webview = webviewRef.current;
    if (!webview || !domReadyRef.current || !workspaceAttachmentScopeKey) return;
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
      void executeWebviewJavaScript(webview, js)
        .then(() => {
          const poll = startSelectorResultPolling({
            webview,
            onSelection: addElementAttachment,
            onDone: () => setSelectorActive(false),
          });
          window.setTimeout(() => {
            window.clearInterval(poll);
            setSelectorActive(false);
            if (webviewRef.current !== webview || !domReadyRef.current) {
              return;
            }
            destroyWebviewSelector(webview);
          }, 30000);
          return undefined;
        })
        .catch(() => {
          setSelectorActive(false);
        });
    } catch {
      setSelectorActive(false);
    }
  }, [addElementAttachment, workspaceAttachmentScopeKey]);

  const cancelElementSelector = useCallback(() => {
    const webview = webviewRef.current;
    setSelectorActive(false);
    if (webview && domReadyRef.current) {
      try {
        clearWebviewSelector(webview);
      } catch {}
    }
  }, []);

  const handleToggleElementSelector = useCallback(() => {
    if (selectorActive) {
      cancelElementSelector();
      return;
    }
    startElementSelector();
  }, [cancelElementSelector, selectorActive, startElementSelector]);

  const handleOpenDevTools = useCallback(() => {
    const currentBrowserId = browserIdRef.current;
    const openDevTools = getDesktopHost()?.browser?.openDevTools;
    if (typeof openDevTools !== "function") {
      console.warn("[browser-pane] openDevTools bridge missing", { browserId: currentBrowserId });
      return;
    }
    void openDevTools(currentBrowserId)
      .then((result) => {
        console.info("[browser-pane] openDevTools result", {
          browserId: currentBrowserId,
          result,
        });
        return undefined;
      })
      .catch((error: unknown) => {
        console.warn("[browser-pane] openDevTools failed", { browserId: currentBrowserId, error });
      });
  }, []);

  const baseIconButtonStyle = useCallback(
    ({ hovered, pressed }: { hovered?: boolean; pressed?: boolean }) => [
      styles.iconButton,
      (hovered || pressed) && styles.iconButtonHovered,
    ],
    [],
  );
  const backIconButtonStyle = useCallback(
    ({ hovered, pressed }: { hovered?: boolean; pressed?: boolean }) => [
      styles.iconButton,
      (hovered || pressed) && styles.iconButtonHovered,
      !browser?.canGoBack && styles.iconButtonDisabled,
    ],
    [browser?.canGoBack],
  );
  const forwardIconButtonStyle = useCallback(
    ({ hovered, pressed }: { hovered?: boolean; pressed?: boolean }) => [
      styles.iconButton,
      (hovered || pressed) && styles.iconButtonHovered,
      !browser?.canGoForward && styles.iconButtonDisabled,
    ],
    [browser?.canGoForward],
  );
  const selectorIconButtonStyle = useCallback(
    ({ hovered, pressed }: { hovered?: boolean; pressed?: boolean }) => [
      styles.iconButton,
      selectorActive && styles.selectorActiveButton,
      (hovered || pressed) && styles.iconButtonHovered,
    ],
    [selectorActive],
  );

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
        <Text style={titleStyle}>Browser is desktop-only</Text>
        <Text style={subtitleStyle}>
          Open this workspace in Electron to use the built-in browser.
        </Text>
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
            onPress={handleBack}
            style={backIconButtonStyle}
          >
            <ArrowLeft size={16} color={theme.colors.foregroundMuted} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Forward"
            disabled={!browser?.canGoForward}
            onPress={handleForward}
            style={forwardIconButtonStyle}
          >
            <ArrowRight size={16} color={theme.colors.foregroundMuted} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={browser?.isLoading ? "Stop loading" : "Refresh"}
            onPress={handleRefresh}
            style={baseIconButtonStyle}
          >
            <RotateCw size={16} color={theme.colors.foregroundMuted} />
          </Pressable>
        </View>
        <View style={styles.urlBarWrap}>
          <TextInput
            accessibilityLabel="Browser URL"
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={setDraftUrl}
            onFocus={handleUrlBarFocus}
            onSubmitEditing={handleNavigateDraftUrl}
            placeholder="Enter URL"
            placeholderTextColor={theme.colors.foregroundMuted}
            ref={urlInputRef}
            style={urlInputStyle}
            value={draftUrl}
          />
        </View>
        <View style={styles.chromeRight}>
          {isDev ? (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Open browser dev tools"
                onPress={handleOpenDevTools}
                style={baseIconButtonStyle}
              >
                <PencilRuler size={16} color={theme.colors.foregroundMuted} />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={selectorActive ? "Cancel element selector" : "Select element"}
                onPress={handleToggleElementSelector}
                style={selectorIconButtonStyle}
              >
                <MousePointer2
                  size={16}
                  color={selectorActive ? theme.colors.accent : theme.colors.foregroundMuted}
                />
              </Pressable>
            </>
          ) : null}
        </View>
      </View>
      {browser?.lastError ? (
        <View style={styles.errorRow}>
          <Text numberOfLines={1} style={errorTextStyle}>
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
    height: WORKSPACE_SECONDARY_HEADER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  chromeLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  chromeRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  iconButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.md,
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
    height: 28,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[2],
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  urlInput: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    paddingVertical: 0,
    paddingHorizontal: 0,
  },
  errorRow: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  metaError: {
    fontSize: theme.fontSize.xs,
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
