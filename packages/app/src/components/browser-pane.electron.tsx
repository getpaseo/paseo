import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  createElement,
} from "react";
import { Pressable, Text, TextInput, View, type StyleProp, type ViewStyle } from "react-native";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  ChevronDown,
  Maximize,
  Monitor,
  MousePointer2,
  RotateCw,
  Smartphone,
  Tablet,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react-native";
import { StyleSheet, useUnistyles, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import * as Clipboard from "expo-clipboard";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/contexts/toast-context";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  buildWorkspaceAttachmentScopeKey,
  useWorkspaceAttachments,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import type { AttachmentMetadata, BrowserElementAttachment } from "@/attachments/types";
import { persistAttachmentFromDataUrl } from "@/attachments/service";
import { WORKSPACE_SECONDARY_HEADER_HEIGHT } from "@/constants/layout";
import {
  getDesktopHost,
  isElectronRuntime,
  type DesktopBrowserShortcutEvent,
} from "@/desktop/host";
import { useBrowserStore, normalizeWorkspaceBrowserUrl } from "@/stores/browser-store";
import {
  prepareBrowserWebview,
  releaseResidentBrowserWebview,
  takeResidentBrowserWebview,
} from "./browser-webview-resident";

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

type BrowserElementSelection = Omit<BrowserElementAttachment, "formatted" | "comment"> & {
  attributes?: Record<string, string>;
};

interface BrowserElementAnnotation {
  comment: string;
}

type DeviceSizeId =
  | "responsive"
  | "iphone-se"
  | "iphone-14"
  | "iphone-14-pro-max"
  | "pixel-7"
  | "galaxy-s20"
  | "ipad-mini"
  | "ipad-air"
  | "ipad-pro-11"
  | "ipad-pro-12"
  | "surface-pro"
  | "laptop"
  | "desktop-1080"
  | "desktop-1440";

interface DeviceSizePreset {
  id: DeviceSizeId;
  /** Display name (not translated — device names are proper nouns). */
  name: string;
  /** Fixed CSS width, or null for "fill the available area". */
  width: number | null;
  height: number | null;
  icon: LucideIcon;
}

// Viewport presets for the in-app browser. "responsive" fills the pane; the
// others render a fixed-size, centered frame so the user can preview how a page
// behaves at common device sizes. Content is centered (not left-aligned).
const DEVICE_SIZE_PRESETS: readonly DeviceSizePreset[] = [
  { id: "responsive", name: "Responsive", width: null, height: null, icon: Maximize },
  { id: "iphone-se", name: "iPhone SE", width: 375, height: 667, icon: Smartphone },
  { id: "iphone-14", name: "iPhone 14", width: 390, height: 844, icon: Smartphone },
  { id: "iphone-14-pro-max", name: "iPhone 14 Pro Max", width: 430, height: 932, icon: Smartphone },
  { id: "pixel-7", name: "Pixel 7", width: 412, height: 915, icon: Smartphone },
  { id: "galaxy-s20", name: "Galaxy S20", width: 360, height: 800, icon: Smartphone },
  { id: "ipad-mini", name: "iPad Mini", width: 768, height: 1024, icon: Tablet },
  { id: "ipad-air", name: "iPad Air", width: 820, height: 1180, icon: Tablet },
  { id: "ipad-pro-11", name: 'iPad Pro 11"', width: 834, height: 1194, icon: Tablet },
  { id: "ipad-pro-12", name: 'iPad Pro 12.9"', width: 1024, height: 1366, icon: Tablet },
  { id: "surface-pro", name: "Surface Pro", width: 912, height: 1368, icon: Tablet },
  { id: "laptop", name: "Laptop", width: 1366, height: 768, icon: Monitor },
  { id: "desktop-1080", name: "Desktop 1080p", width: 1920, height: 1080, icon: Monitor },
  { id: "desktop-1440", name: "Desktop 1440p", width: 2560, height: 1440, icon: Monitor },
];

const RESPONSIVE_DEVICE_LABEL_KEY = "workspace.browser.devices.responsive";

function formatDevicePresetLabel(preset: DeviceSizePreset, responsiveLabel: string): string {
  const name = preset.id === "responsive" ? responsiveLabel : preset.name;
  if (preset.width && preset.height) {
    return `${name} · ${preset.width}×${preset.height}`;
  }
  return name;
}

const ERR_ABORTED = -3;
const ALLOWED_BROWSER_PROTOCOLS = new Set(["http:", "https:"]);

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength).trim()}...` : value;
}

function getWebviewLoadErrorMessage(event: Event, failedToLoadLabel: string): string | null {
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
      : failedToLoadLabel;
  const url =
    typeof details.validatedURL === "string" && details.validatedURL.trim()
      ? details.validatedURL.trim()
      : null;

  return url ? `${description}: ${url}` : description;
}

function getLoadUrlRejectionMessage(error: unknown, failedToLoadLabel: string): string | null {
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
  return failedToLoadLabel;
}

function getUnsafeNavigationMessage(
  url: string,
  labels: { invalidUrl: string; unsupportedProtocol: (protocol: string) => string },
): string | null {
  try {
    const parsed = new URL(url);
    if (ALLOWED_BROWSER_PROTOCOLS.has(parsed.protocol) || parsed.href === "about:blank") {
      return null;
    }
    return labels.unsupportedProtocol(parsed.protocol);
  } catch {
    return labels.invalidUrl;
  }
}

function formatElementAttachment(
  selection: BrowserElementSelection,
  annotation?: BrowserElementAnnotation,
): string {
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

  const comment = annotation?.comment.trim();
  if (comment) {
    parts.push(`feedback: ${comment}`);
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
  annotation?: BrowserElementAnnotation,
  screenshot?: AttachmentMetadata,
): BrowserElementAttachment {
  const comment = annotation?.comment.trim();
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
    ...(comment ? { comment } : {}),
    ...(screenshot ? { screenshot } : {}),
    formatted: formatElementAttachment(selection, annotation),
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

interface BrowserAnnotationMarker {
  index: number;
  selector: string;
}

// Draws numbered badges over annotated elements inside the guest page. The
// overlay is a fixed, pointer-events:none layer that re-measures element rects
// on scroll/resize via rAF. Markers are matched by the CSS selector captured at
// annotation time; unmatched selectors are simply skipped.
function buildAnnotationMarkerScript(markers: readonly BrowserAnnotationMarker[]): string {
  const payload = JSON.stringify(
    markers.map((marker) => ({ index: marker.index, selector: marker.selector })),
  );
  return `
    (function() {
      var markers = ${payload};
      if (window.__paseoAnnotationMarkers) { window.__paseoAnnotationMarkers.update(markers); return true; }
      var host = document.createElement('div');
      host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483646;pointer-events:none;';
      (document.body || document.documentElement).appendChild(host);
      var badges = [];
      var current = markers;
      function clearBadges() {
        for (var i = 0; i < badges.length; i++) { if (badges[i].parentNode) badges[i].parentNode.removeChild(badges[i]); }
        badges = [];
      }
      function reposition() {
        clearBadges();
        for (var i = 0; i < current.length; i++) {
          var m = current[i];
          var el = null;
          try { el = document.querySelector(m.selector); } catch (e) { el = null; }
          if (!el) continue;
          var rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;
          var badge = document.createElement('div');
          badge.textContent = String(m.index);
          badge.style.cssText = 'position:fixed;min-width:18px;height:18px;padding:0 4px;border-radius:9px;background:#2563eb;color:#fff;font:600 11px/18px -apple-system,system-ui,sans-serif;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.4);pointer-events:none;box-sizing:border-box;';
          badge.style.left = Math.max(0, rect.left) + 'px';
          badge.style.top = Math.max(0, rect.top) + 'px';
          host.appendChild(badge);
          badges.push(badge);
        }
      }
      var scheduled = false;
      function schedule() {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(function() { scheduled = false; reposition(); });
      }
      window.addEventListener('scroll', schedule, true);
      window.addEventListener('resize', schedule, true);
      window.__paseoAnnotationMarkers = {
        update: function(next) { current = next; schedule(); },
        destroy: function() {
          window.removeEventListener('scroll', schedule, true);
          window.removeEventListener('resize', schedule, true);
          clearBadges();
          if (host.parentNode) host.parentNode.removeChild(host);
          window.__paseoAnnotationMarkers = null;
        }
      };
      reposition();
      return true;
    })()
  `;
}

function applyAnnotationMarkers(
  webview: ElectronWebview,
  markers: readonly BrowserAnnotationMarker[],
): void {
  void executeWebviewJavaScript(webview, buildAnnotationMarkerScript(markers)).catch(
    ignoreWebviewJavaScriptError,
  );
}

function clearAnnotationMarkers(webview: ElectronWebview): void {
  void executeWebviewJavaScript(
    webview,
    "if(window.__paseoAnnotationMarkers) window.__paseoAnnotationMarkers.destroy();",
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

function ToolbarButton({
  label,
  children,
  active,
  disabled,
  onPress,
  style,
}: {
  label: string;
  children: ReactNode;
  active?: boolean;
  disabled?: boolean;
  onPress: () => void;
  style: (state: { hovered?: boolean; pressed?: boolean }) => StyleProp<ViewStyle>;
}) {
  const accessibilityState = useMemo(
    () => ({ disabled: Boolean(disabled), selected: Boolean(active) }),
    [active, disabled],
  );
  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild disabled={disabled}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={accessibilityState}
          disabled={disabled}
          onPress={onPress}
          style={style}
        >
          {children}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="center" offset={8}>
        <Text style={styles.toolbarTooltipText}>{label}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

// Lucide icons themed via withUnistyles so their color stays theme-reactive
// without a banned useUnistyles() call.
const ThemedMaximize = withUnistyles(Maximize);
const ThemedSmartphone = withUnistyles(Smartphone);
const ThemedTablet = withUnistyles(Tablet);
const ThemedMonitor = withUnistyles(Monitor);
const ThemedChevronDown = withUnistyles(ChevronDown);
const deviceMutedIconMapping = (theme: { colors: { foregroundMuted: string } }) => ({
  color: theme.colors.foregroundMuted,
});

function resolveThemedDeviceIcon(icon: LucideIcon): typeof ThemedMaximize {
  if (icon === Smartphone) return ThemedSmartphone;
  if (icon === Tablet) return ThemedTablet;
  if (icon === Monitor) return ThemedMonitor;
  return ThemedMaximize;
}

function DeviceSizeMenuItem({
  preset,
  selected,
  label,
  onSelect,
}: {
  preset: DeviceSizePreset;
  selected: boolean;
  label: string;
  onSelect: (id: DeviceSizeId) => void;
}) {
  const ThemedIcon = resolveThemedDeviceIcon(preset.icon);
  const handleSelect = useCallback(() => {
    onSelect(preset.id);
  }, [onSelect, preset.id]);
  const leading = useMemo(
    () => <ThemedIcon size={16} uniProps={deviceMutedIconMapping} />,
    [ThemedIcon],
  );
  return (
    <DropdownMenuItem
      onSelect={handleSelect}
      selected={selected}
      showSelectedCheck
      leading={leading}
    >
      {label}
    </DropdownMenuItem>
  );
}

function DeviceSizeMenu({
  selectedId,
  onSelect,
  triggerStyle,
}: {
  selectedId: DeviceSizeId;
  onSelect: (id: DeviceSizeId) => void;
  triggerStyle: (state: { hovered?: boolean; pressed?: boolean }) => StyleProp<ViewStyle>;
}) {
  const { t } = useTranslation();
  const selectedPreset =
    DEVICE_SIZE_PRESETS.find((preset) => preset.id === selectedId) ?? DEVICE_SIZE_PRESETS[0];
  const SelectedIcon = resolveThemedDeviceIcon(selectedPreset.icon);
  const label = t("workspace.browser.devices.label");
  return (
    <DropdownMenu>
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger accessibilityLabel={label} style={triggerStyle}>
            <View style={styles.deviceTrigger}>
              <SelectedIcon size={16} uniProps={deviceMutedIconMapping} />
              <ThemedChevronDown size={12} uniProps={deviceMutedIconMapping} />
            </View>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center" offset={8}>
          <Text style={styles.toolbarTooltipText}>{label}</Text>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" scrollable maxHeight={360}>
        {DEVICE_SIZE_PRESETS.map((preset) => (
          <DeviceSizeMenuItem
            key={preset.id}
            preset={preset}
            selected={preset.id === selectedId}
            label={formatDevicePresetLabel(preset, t(RESPONSIVE_DEVICE_LABEL_KEY))}
            onSelect={onSelect}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
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
  const { t } = useTranslation();
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
  const annotationMarkersRef = useRef<BrowserAnnotationMarker[]>([]);
  const [selectorMode, setSelectorMode] = useState<"annotate" | "screenshot" | null>(null);
  const selectorActive = selectorMode !== null;
  // Which action the active selector performs on click: open the annotation card
  // ("annotate") or copy a screenshot of the element to the clipboard ("screenshot").
  const selectorModeRef = useRef<"annotate" | "screenshot">("annotate");
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const [deviceSizeId, setDeviceSizeId] = useState<DeviceSizeId>("responsive");
  const [pendingSelection, setPendingSelection] = useState<BrowserElementSelection | null>(null);
  // Screenshot is captured at selection time (overlay already torn down, no
  // scroll drift) and reused when the annotation card is submitted.
  const pendingScreenshotRef = useRef<AttachmentMetadata | undefined>(undefined);
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
  const browserErrorLabels = useMemo(
    () => ({
      failedToLoad: t("workspace.browser.errors.failedToLoad"),
      invalidUrl: t("workspace.browser.errors.invalidUrl"),
      unsupportedProtocol: (protocol: string) =>
        t("workspace.browser.errors.unsupportedProtocol", { protocol }),
    }),
    [t],
  );
  const browserErrorLabelsRef = useRef(browserErrorLabels);
  browserErrorLabelsRef.current = browserErrorLabels;

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

    const initialUnsafeNavigationMessage = getUnsafeNavigationMessage(
      initialUrlRef.current,
      browserErrorLabelsRef.current,
    );
    const residentWebview = takeResidentBrowserWebview(browserId) as ElectronWebview | null;
    const webview = residentWebview ?? (document.createElement("webview") as ElectronWebview);
    webviewRef.current = webview;
    void getDesktopHost()?.browser?.registerWorkspaceBrowser?.({ browserId, workspaceId });
    if (!residentWebview) {
      prepareBrowserWebview(webview, {
        browserId,
        initialUrl: initialUnsafeNavigationMessage ? "about:blank" : initialUrlRef.current,
      });
    }
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
      const message = getWebviewLoadErrorMessage(event, browserErrorLabelsRef.current.failedToLoad);
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
      // The previous page's overlay is gone after a load; re-apply markers for
      // the freshly loaded document.
      const markers = annotationMarkersRef.current;
      if (markers.length > 0) {
        applyAnnotationMarkers(webview, markers);
      }
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
        const browserStillExists = Boolean(
          useBrowserStore.getState().browsersById[browserIdRef.current],
        );
        if (browserStillExists) {
          releaseResidentBrowserWebview(browserIdRef.current, webview);
        } else {
          host.removeChild(webview);
        }
      }
      if (webviewRef.current === webview) {
        webviewRef.current = null;
      }
      domReadyRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browserId, onFocusPane]);

  const navigate = useCallback(
    (nextUrl: string) => {
      const normalizedUrl = normalizeWorkspaceBrowserUrl(nextUrl);
      const webview = webviewRef.current;
      const unsafeNavigationMessage = getUnsafeNavigationMessage(normalizedUrl, browserErrorLabels);
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
          const message = getLoadUrlRejectionMessage(error, browserErrorLabels.failedToLoad);
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
    },
    [browserErrorLabels],
  );

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
    (
      selection: BrowserElementSelection,
      annotation: BrowserElementAnnotation,
      screenshot?: AttachmentMetadata,
    ) => {
      if (!workspaceAttachmentScopeKey) {
        return;
      }
      setWorkspaceAttachments({
        scopeKey: workspaceAttachmentScopeKey,
        attachments: [
          ...workspaceAttachments,
          {
            kind: "browser_element",
            attachment: buildBrowserElementAttachment(selection, annotation, screenshot),
          },
        ],
      });
    },
    [setWorkspaceAttachments, workspaceAttachmentScopeKey, workspaceAttachments],
  );

  const captureElementScreenshot = useCallback(
    async (selection: BrowserElementSelection): Promise<AttachmentMetadata | undefined> => {
      const captureElement = getDesktopHost()?.browser?.captureElement;
      if (typeof captureElement !== "function") {
        return undefined;
      }
      const { x, y, width, height } = selection.boundingRect;
      if (width <= 0 || height <= 0) {
        return undefined;
      }
      try {
        const dataUrl = await captureElement(browserIdRef.current, { x, y, width, height });
        if (!dataUrl) {
          return undefined;
        }
        return await persistAttachmentFromDataUrl({
          dataUrl,
          mimeType: "image/png",
          fileName: `element-${selection.tag}.png`,
        });
      } catch (error) {
        console.warn("[browser-pane] captureElement failed", error);
        return undefined;
      }
    },
    [],
  );

  const screenshotElementToClipboard = useCallback(
    async (selection: BrowserElementSelection) => {
      const text = formatElementAttachment(selection);
      const copyElement = getDesktopHost()?.browser?.copyElement;
      const captureElement = getDesktopHost()?.browser?.captureElement;
      const { x, y, width, height } = selection.boundingRect;

      let imageDataUrl: string | undefined;
      if (typeof captureElement === "function" && width > 0 && height > 0) {
        try {
          const dataUrl = await captureElement(browserIdRef.current, { x, y, width, height });
          imageDataUrl = dataUrl ?? undefined;
        } catch (error) {
          console.warn("[browser-pane] capture element for screenshot failed", error);
        }
      }

      const copiedMessage = imageDataUrl
        ? t("workspace.browser.controls.screenshotCopied")
        : t("workspace.browser.controls.elementCopied");

      // Copy via the main process; the renderer's navigator.clipboard rejects
      // with NotAllowedError because focus is inside the guest <webview>.
      if (typeof copyElement === "function") {
        try {
          const ok = await copyElement({ text, imageDataUrl });
          if (ok) {
            toastRef.current?.show(copiedMessage, { variant: "success" });
          } else {
            toastRef.current?.error(t("workspace.browser.controls.screenshotFailed"));
          }
          return;
        } catch (error) {
          console.warn("[browser-pane] copyElement bridge failed", error);
        }
      }

      // Fallback to expo-clipboard (text only) when the bridge is unavailable.
      try {
        await Clipboard.setStringAsync(text);
        toastRef.current?.show(t("workspace.browser.controls.elementCopied"), {
          variant: "success",
        });
      } catch (error) {
        console.warn("[browser-pane] clipboard fallback failed", error);
        toastRef.current?.error(t("workspace.browser.controls.screenshotFailed"));
      }
    },
    [t],
  );

  const handleSelectorResult = useCallback(
    (selection: BrowserElementSelection) => {
      if (selectorModeRef.current === "screenshot") {
        void screenshotElementToClipboard(selection);
        return;
      }
      pendingScreenshotRef.current = undefined;
      setPendingSelection(selection);
      void captureElementScreenshot(selection).then((screenshot) => {
        pendingScreenshotRef.current = screenshot;
        return undefined;
      });
    },
    [captureElementScreenshot, screenshotElementToClipboard],
  );

  const submitAnnotation = useCallback(
    (annotation: BrowserElementAnnotation) => {
      const selection = pendingSelection;
      const screenshot = pendingScreenshotRef.current;
      pendingScreenshotRef.current = undefined;
      setPendingSelection(null);
      if (!selection) {
        return;
      }
      addElementAttachment(selection, annotation, screenshot);
    },
    [addElementAttachment, pendingSelection],
  );

  const cancelAnnotation = useCallback(() => {
    pendingScreenshotRef.current = undefined;
    setPendingSelection(null);
  }, []);

  const startElementSelector = useCallback(
    (mode: "annotate" | "screenshot") => {
      const webview = webviewRef.current;
      if (!webview || !domReadyRef.current) return;
      // Annotate needs a workspace scope to attach to; screenshot only copies.
      if (mode === "annotate" && !workspaceAttachmentScopeKey) return;
      selectorModeRef.current = mode;
      pendingScreenshotRef.current = undefined;
      setPendingSelection(null);
      setSelectorMode(mode);

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
          '.__paseo-hover-label { position: fixed; z-index: 2147483647; pointer-events: none; max-width: 360px; padding: 4px 8px; border-radius: 6px; background: rgba(24,24,27,0.96); color: #fff; font: 500 11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace; box-shadow: 0 2px 10px rgba(0,0,0,0.35); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
          '.__paseo-hover-label .__paseo-tag { color: #93c5fd; }',
          '.__paseo-hover-label .__paseo-id { color: #fca5a5; }',
          '.__paseo-hover-label .__paseo-cls { color: #fcd34d; }',
          '.__paseo-hover-label .__paseo-dim { color: #a1a1aa; margin-left: 6px; }',
          '.__paseo-hover-label .__paseo-comp { color: #86efac; margin-left: 6px; }',
        ].join('\\n');
        document.head.appendChild(style);
        document.documentElement.classList.add('__paseo-select-mode');
        var hoverLabel = document.createElement('div');
        hoverLabel.className = '__paseo-hover-label';
        hoverLabel.style.display = 'none';
        document.documentElement.appendChild(hoverLabel);
        var last = null;
        function escapeHtml(value) {
          return String(value).replace(/[&<>"]/g, function(ch) {
            return ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : '&quot;';
          });
        }
        function describeElement(el) {
          var tag = el.tagName ? el.tagName.toLowerCase() : 'node';
          var parts = ['<span class="__paseo-tag">' + escapeHtml(tag) + '</span>'];
          if (el.id) {
            parts.push('<span class="__paseo-id">#' + escapeHtml(el.id) + '</span>');
          }
          if (el.classList && el.classList.length) {
            var cls = Array.prototype.slice.call(el.classList, 0, 2)
              .filter(function(c) { return c.indexOf('__paseo') !== 0; })
              .map(function(c) { return '.' + escapeHtml(c); })
              .join('');
            if (cls) parts.push('<span class="__paseo-cls">' + cls + '</span>');
          }
          var comp = getReactSource(el);
          if (comp && comp.componentName) {
            parts.push('<span class="__paseo-comp">&lt;' + escapeHtml(comp.componentName) + '&gt;</span>');
          }
          var rect = el.getBoundingClientRect();
          parts.push('<span class="__paseo-dim">' + Math.round(rect.width) + '×' + Math.round(rect.height) + '</span>');
          return { html: parts.join(''), rect: rect };
        }
        function positionLabel(rect, e) {
          var pad = 12;
          var lw = hoverLabel.offsetWidth || 0;
          var lh = hoverLabel.offsetHeight || 0;
          var top = rect.top - lh - 6;
          if (top < 4) top = rect.bottom + 6;
          if (top + lh > window.innerHeight - 4) top = Math.max(4, e.clientY - lh - 6);
          var left = rect.left;
          if (left + lw > window.innerWidth - 4) left = Math.max(4, window.innerWidth - lw - 4);
          if (left < 4) left = 4;
          hoverLabel.style.top = Math.round(top) + 'px';
          hoverLabel.style.left = Math.round(left) + 'px';
        }
        function onMove(e) {
          e.preventDefault();
          e.stopPropagation();
          if (last) last.classList.remove('__paseo-hover');
          var el = e.target;
          el.classList.add('__paseo-hover');
          last = el;
          try {
            var info = describeElement(el);
            hoverLabel.innerHTML = info.html;
            hoverLabel.style.display = 'block';
            positionLabel(info.rect, e);
          } catch (err) {
            hoverLabel.style.display = 'none';
          }
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
          hoverLabel.style.display = 'none';
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
          if (hoverLabel.parentNode) hoverLabel.parentNode.removeChild(hoverLabel);
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
              onSelection: handleSelectorResult,
              onDone: () => setSelectorMode(null),
            });
            window.setTimeout(() => {
              window.clearInterval(poll);
              setSelectorMode(null);
              if (webviewRef.current !== webview || !domReadyRef.current) {
                return;
              }
              destroyWebviewSelector(webview);
            }, 30000);
            return undefined;
          })
          .catch(() => {
            setSelectorMode(null);
          });
      } catch {
        setSelectorMode(null);
      }
    },
    [handleSelectorResult, workspaceAttachmentScopeKey],
  );

  const cancelElementSelector = useCallback(() => {
    const webview = webviewRef.current;
    setSelectorMode(null);
    if (webview && domReadyRef.current) {
      try {
        clearWebviewSelector(webview);
      } catch {}
    }
  }, []);

  const currentPageUrl = browser?.url ?? null;
  const annotationMarkers = useMemo<BrowserAnnotationMarker[]>(() => {
    if (!currentPageUrl) {
      return [];
    }
    const normalizedCurrent = normalizeWorkspaceBrowserUrl(currentPageUrl);
    const markers: BrowserAnnotationMarker[] = [];
    let index = 0;
    for (const attachment of workspaceAttachments) {
      if (attachment.kind !== "browser_element") {
        continue;
      }
      index += 1;
      if (normalizeWorkspaceBrowserUrl(attachment.attachment.url) !== normalizedCurrent) {
        continue;
      }
      markers.push({ index, selector: attachment.attachment.selector });
    }
    return markers;
  }, [currentPageUrl, workspaceAttachments]);

  const markersKey = useMemo(() => JSON.stringify(annotationMarkers), [annotationMarkers]);
  annotationMarkersRef.current = annotationMarkers;

  useEffect(() => {
    if (!isElectronRuntime()) {
      return;
    }
    const webview = webviewRef.current;
    if (!webview || !domReadyRef.current) {
      return;
    }
    if (annotationMarkers.length === 0) {
      clearAnnotationMarkers(webview);
      return;
    }
    applyAnnotationMarkers(webview, annotationMarkers);
    // markersKey captures the marker contents; re-run when they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markersKey, currentPageUrl]);

  const handleToggleElementSelector = useCallback(() => {
    if (selectorActive) {
      cancelElementSelector();
      return;
    }
    startElementSelector("annotate");
  }, [cancelElementSelector, selectorActive, startElementSelector]);

  const handleToggleScreenshot = useCallback(() => {
    if (selectorActive) {
      cancelElementSelector();
      return;
    }
    startElementSelector("screenshot");
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
  const annotateIconButtonStyle = useCallback(
    ({ hovered, pressed }: { hovered?: boolean; pressed?: boolean }) => [
      styles.iconButton,
      selectorMode === "annotate" && styles.selectorActiveButton,
      (hovered || pressed) && styles.iconButtonHovered,
    ],
    [selectorMode],
  );
  const screenshotIconButtonStyle = useCallback(
    ({ hovered, pressed }: { hovered?: boolean; pressed?: boolean }) => [
      styles.iconButton,
      selectorMode === "screenshot" && styles.selectorActiveButton,
      (hovered || pressed) && styles.iconButtonHovered,
    ],
    [selectorMode],
  );

  const devicePreset = useMemo(
    () =>
      DEVICE_SIZE_PRESETS.find((preset) => preset.id === deviceSizeId) ?? DEVICE_SIZE_PRESETS[0],
    [deviceSizeId],
  );
  const isResponsiveDevice = devicePreset.width === null;

  const webviewHostStyle = useMemo<CSSProperties>(
    () =>
      isResponsiveDevice
        ? {
            display: "flex",
            flex: 1,
            width: "100%",
            height: "100%",
            minHeight: 0,
            background: theme.colors.surface0,
          }
        : {
            // Fixed-size device frame, centered within webviewWrap (see styles).
            display: "flex",
            width: devicePreset.width ?? undefined,
            maxWidth: "100%",
            height: devicePreset.height ?? undefined,
            maxHeight: "100%",
            minHeight: 0,
            background: theme.colors.surface0,
            boxShadow: "0 2px 16px rgba(0,0,0,0.25)",
          },
    [devicePreset.height, devicePreset.width, isResponsiveDevice, theme.colors.surface0],
  );

  const webviewWrapStyle = useMemo(
    () => [styles.webviewWrap, !isResponsiveDevice && styles.webviewWrapDeviceFrame],
    [isResponsiveDevice],
  );

  const setWebviewHostNode = useCallback((node: HTMLDivElement | null) => {
    webviewHostRef.current = node;
  }, []);

  if (!isElectronRuntime()) {
    return (
      <View style={styles.unavailableState}>
        <Text style={titleStyle}>{t("workspace.browser.unavailable.title")}</Text>
        <Text style={subtitleStyle}>{t("workspace.browser.unavailable.subtitle")}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.chromeRow}>
        <View style={styles.chromeLeft}>
          <ToolbarButton
            label={t("workspace.browser.controls.back")}
            disabled={!browser?.canGoBack}
            onPress={handleBack}
            style={backIconButtonStyle}
          >
            <ArrowLeft size={16} color={theme.colors.foregroundMuted} />
          </ToolbarButton>
          <ToolbarButton
            label={t("workspace.browser.controls.forward")}
            disabled={!browser?.canGoForward}
            onPress={handleForward}
            style={forwardIconButtonStyle}
          >
            <ArrowRight size={16} color={theme.colors.foregroundMuted} />
          </ToolbarButton>
          <ToolbarButton
            label={
              browser?.isLoading
                ? t("workspace.browser.controls.stopLoading")
                : t("workspace.browser.controls.refresh")
            }
            onPress={handleRefresh}
            style={baseIconButtonStyle}
          >
            <RotateCw size={16} color={theme.colors.foregroundMuted} />
          </ToolbarButton>
        </View>
        <View style={styles.urlBarWrap}>
          <TextInput
            accessibilityLabel={t("workspace.browser.controls.browserUrl")}
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={setDraftUrl}
            onFocus={handleUrlBarFocus}
            onSubmitEditing={handleNavigateDraftUrl}
            placeholder={t("workspace.browser.controls.enterUrl")}
            placeholderTextColor={theme.colors.foregroundMuted}
            ref={urlInputRef}
            style={urlInputStyle}
            value={draftUrl}
          />
        </View>
        <View style={styles.chromeRight}>
          <DeviceSizeMenu
            selectedId={deviceSizeId}
            onSelect={setDeviceSizeId}
            triggerStyle={baseIconButtonStyle}
          />
          <ToolbarButton
            label={t("workspace.browser.controls.openDevTools")}
            onPress={handleOpenDevTools}
            style={baseIconButtonStyle}
          >
            <Wrench size={16} color={theme.colors.foregroundMuted} />
          </ToolbarButton>
          <ToolbarButton
            label={
              selectorMode === "annotate"
                ? t("workspace.browser.controls.cancelSelector")
                : t("workspace.browser.controls.annotateElement")
            }
            active={selectorMode === "annotate"}
            onPress={handleToggleElementSelector}
            style={annotateIconButtonStyle}
          >
            <MousePointer2
              size={16}
              color={
                selectorMode === "annotate" ? theme.colors.accent : theme.colors.foregroundMuted
              }
            />
          </ToolbarButton>
          <ToolbarButton
            label={
              selectorMode === "screenshot"
                ? t("workspace.browser.controls.cancelSelector")
                : t("workspace.browser.controls.screenshotElement")
            }
            active={selectorMode === "screenshot"}
            onPress={handleToggleScreenshot}
            style={screenshotIconButtonStyle}
          >
            <Camera
              size={16}
              color={
                selectorMode === "screenshot" ? theme.colors.accent : theme.colors.foregroundMuted
              }
            />
          </ToolbarButton>
        </View>
      </View>
      {browser?.lastError ? (
        <View style={styles.errorRow}>
          <Text numberOfLines={1} style={errorTextStyle}>
            {browser.lastError}
          </Text>
        </View>
      ) : null}
      <View style={webviewWrapStyle}>
        {createElement("div", {
          ref: setWebviewHostNode,
          style: webviewHostStyle,
        })}
        {pendingSelection ? (
          <BrowserElementAnnotationCard
            selection={pendingSelection}
            onSubmit={submitAnnotation}
            onCancel={cancelAnnotation}
          />
        ) : null}
      </View>
    </View>
  );
}

function BrowserElementAnnotationCard({
  selection,
  onSubmit,
  onCancel,
}: {
  selection: BrowserElementSelection;
  onSubmit: (annotation: BrowserElementAnnotation) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [comment, setComment] = useState("");
  const commentRef = useRef(comment);
  commentRef.current = comment;

  const handleSubmit = useCallback(() => {
    onSubmit({ comment: commentRef.current });
  }, [onSubmit]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
        return;
      }
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        event.stopPropagation();
        handleSubmit();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [handleSubmit, onCancel]);

  const elementText = truncateText(selection.text.trim().replace(/\s+/g, " "), 60);
  const elementLabel = elementText ? `${selection.tag} · ${elementText}` : selection.tag;

  return (
    <View style={styles.annotationOverlay} pointerEvents="box-none">
      <View style={styles.annotationCard}>
        <View style={styles.annotationHeader}>
          <Text numberOfLines={1} style={styles.annotationTitle}>
            {t("workspace.browser.annotate.title")}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("workspace.browser.annotate.cancel")}
            onPress={onCancel}
            style={styles.annotationCloseButton}
          >
            <ThemedCloseIcon size={16} uniProps={iconForegroundMutedMapping} />
          </Pressable>
        </View>
        <Text numberOfLines={1} style={styles.annotationElement}>
          {elementLabel}
        </Text>
        <ThemedAnnotationInput
          accessibilityLabel={t("workspace.browser.annotate.placeholder")}
          autoFocus
          multiline
          onChangeText={setComment}
          placeholder={t("workspace.browser.annotate.placeholder")}
          style={styles.annotationInput}
          uniProps={annotationInputMapping}
          value={comment}
        />
        <View style={styles.annotationActions}>
          <Button variant="ghost" size="sm" onPress={onCancel}>
            {t("workspace.browser.annotate.cancel")}
          </Button>
          <Button variant="default" size="sm" onPress={handleSubmit}>
            {t("workspace.browser.annotate.submit")}
          </Button>
        </View>
      </View>
    </View>
  );
}

const ThemedCloseIcon = withUnistyles(X);
const ThemedAnnotationInput = withUnistyles(TextInput);
const iconForegroundMutedMapping = (theme: { colors: { foregroundMuted: string } }) => ({
  color: theme.colors.foregroundMuted,
});
const annotationInputMapping = (theme: { colors: { foregroundMuted: string } }) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
});

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
    flexShrink: 0,
  },
  chromeRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
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
  // When a fixed device size is active, center the framed webview both axes over
  // a muted backdrop instead of left-aligning it.
  webviewWrapDeviceFrame: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[3],
  },
  deviceTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  toolbarTooltipText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.popoverForeground,
  },
  annotationOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    padding: theme.spacing[3],
    alignItems: "center",
  },
  annotationCard: {
    width: "100%",
    maxWidth: 420,
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
  },
  annotationHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  annotationTitle: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
    color: theme.colors.foreground,
  },
  annotationCloseButton: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  annotationElement: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    marginBottom: theme.spacing[2],
  },
  annotationInput: {
    minHeight: 64,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    textAlignVertical: "top",
  },
  annotationActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
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
