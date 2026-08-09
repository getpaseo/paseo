import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ComponentRef,
  type ReactNode,
} from "react";
import {
  ActivityIndicator,
  BackHandler,
  Pressable,
  Text,
  TextInput,
  View,
  type LayoutChangeEvent,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { WebView, type WebViewMessageEvent, type WebViewNavigation } from "react-native-webview";
import { captureRef } from "react-native-view-shot";
import * as Clipboard from "expo-clipboard";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
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
  X,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { persistAttachmentFromFileUri } from "@/attachments/service";
import type { AttachmentMetadata } from "@/attachments/types";
import {
  useWorkspaceAttachments,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import {
  buildAnnotationMarkerScript,
  buildBrowserAttachmentScopeKey,
  buildBrowserElementAttachment,
  CLEAR_ANNOTATION_MARKERS_SCRIPT,
  formatBrowserElementAttachment,
  truncateBrowserText,
  type BrowserAnnotationMarker,
  type BrowserElementAnnotation,
  type BrowserElementSelection,
} from "@/desktop/browser/browser-element-attachment";
import {
  BROWSER_DEVICE_SIZE_PRESETS,
  formatBrowserDevicePresetLabel,
  getBrowserDevicePreset,
  RESPONSIVE_BROWSER_DEVICE_LABEL_KEY,
  type BrowserDeviceSizeId,
  type BrowserDeviceSizePreset,
} from "@/desktop/browser/device-presets";
import { resolveMobileBrowserNavigation } from "@/desktop/browser/mobile-browser-navigation";
import {
  buildMobileBrowserSelectorScript,
  DESTROY_MOBILE_BROWSER_SELECTOR_SCRIPT,
  MOBILE_BROWSER_PAGE_METADATA_SCRIPT,
} from "@/desktop/browser/mobile-browser-selector";
import {
  claimMobileBrowserHost,
  setMobileBrowserTunnelNotice,
  useMobileBrowserTunnelStore,
} from "@/desktop/browser/mobile-browser-tunnel-state";
import { useWorkspaceBrowserAvailability } from "@/desktop/browser/workspace-browser-availability";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/contexts/toast-context";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { normalizeWorkspaceBrowserUrl, useBrowserStore } from "@/desktop/browser/store";

type WebViewRef = ComponentRef<typeof WebView>;
type WebViewErrorEvent = Parameters<NonNullable<ComponentProps<typeof WebView>["onError"]>>[0];
type WebViewHttpErrorEvent = Parameters<
  NonNullable<ComponentProps<typeof WebView>["onHttpError"]>
>[0];

type SelectorMode = "annotate" | "screenshot";

interface BrowserPaneProps {
  browserId: string;
  serverId: string;
  workspaceId: string;
  cwd: string | null;
  isInteractive?: boolean;
  isWorkspaceFocused?: boolean;
  onFocusPane?: () => void;
  onOpenUrlInBrowserTab?: (url: string) => void;
  chrome?: "visible" | "hidden";
}

interface CaptureSize {
  width: number;
  height: number;
}

interface BrowserPageMessage {
  type: "paseo-page";
  title?: unknown;
  faviconUrl?: unknown;
}

interface BrowserSelectionMessage {
  type: "paseo-selection";
  selection?: unknown;
}

function isBrowserElementSelection(value: unknown): value is BrowserElementSelection {
  if (!value || typeof value !== "object") {
    return false;
  }
  const selection = value as Partial<BrowserElementSelection>;
  const rect = selection.boundingRect;
  return (
    typeof selection.url === "string" &&
    typeof selection.selector === "string" &&
    typeof selection.tag === "string" &&
    typeof selection.text === "string" &&
    typeof selection.outerHTML === "string" &&
    Boolean(rect) &&
    typeof rect?.x === "number" &&
    typeof rect.y === "number" &&
    typeof rect.width === "number" &&
    typeof rect.height === "number" &&
    Boolean(selection.computedStyles) &&
    Array.isArray(selection.parentChain) &&
    Array.isArray(selection.children)
  );
}

function parseWebViewMessage(data: string): BrowserPageMessage | BrowserSelectionMessage | null {
  try {
    const parsed = JSON.parse(data) as { type?: unknown };
    if (parsed.type === "paseo-page" || parsed.type === "paseo-selection") {
      return parsed as BrowserPageMessage | BrowserSelectionMessage;
    }
  } catch {
    // Third-party pages may use postMessage for their own data.
  }
  return null;
}

const ThemedArrowLeft = withUnistyles(ArrowLeft);
const ThemedArrowRight = withUnistyles(ArrowRight);
const ThemedCamera = withUnistyles(Camera);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedMaximize = withUnistyles(Maximize);
const ThemedMonitor = withUnistyles(Monitor);
const ThemedMousePointer2 = withUnistyles(MousePointer2);
const ThemedRotateCw = withUnistyles(RotateCw);
const ThemedSmartphone = withUnistyles(Smartphone);
const ThemedTablet = withUnistyles(Tablet);
const ThemedTextInput = withUnistyles(TextInput);
const ThemedX = withUnistyles(X);

const mutedColorMapping = (theme: { colors: { foregroundMuted: string } }) => ({
  color: theme.colors.foregroundMuted,
});
const accentColorMapping = (theme: { colors: { accent: string } }) => ({
  color: theme.colors.accent,
});
const inputPlaceholderMapping = (theme: { colors: { foregroundMuted: string } }) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
});

function getDeviceIcon(kind: BrowserDeviceSizePreset["kind"]): typeof ThemedMaximize {
  if (kind === "phone") return ThemedSmartphone;
  if (kind === "tablet") return ThemedTablet;
  if (kind === "desktop") return ThemedMonitor;
  return ThemedMaximize;
}

function ToolbarButton({
  label,
  active,
  disabled,
  onPress,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  const accessibilityState = useMemo(
    () => ({ disabled: Boolean(disabled), selected: Boolean(active) }),
    [active, disabled],
  );
  const buttonStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.iconButton,
      active && styles.iconButtonActive,
      pressed && styles.iconButtonPressed,
      disabled && styles.iconButtonDisabled,
    ],
    [active, disabled],
  );
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      disabled={disabled}
      onPress={onPress}
      style={buttonStyle}
    >
      {children}
    </Pressable>
  );
}

function DeviceSizeMenuItem({
  preset,
  responsiveLabel,
  onSelect,
}: {
  preset: BrowserDeviceSizePreset;
  responsiveLabel: string;
  onSelect: (id: BrowserDeviceSizeId) => void;
}) {
  const Icon = getDeviceIcon(preset.kind);
  const handleSelect = useCallback(() => onSelect(preset.id), [onSelect, preset.id]);
  return (
    <DropdownMenuItem onSelect={handleSelect}>
      <Icon size={16} uniProps={mutedColorMapping} />
      <Text style={styles.deviceLabel}>
        {formatBrowserDevicePresetLabel(preset, responsiveLabel)}
      </Text>
    </DropdownMenuItem>
  );
}

function DeviceSizeMenu({
  selectedId,
  onSelect,
}: {
  selectedId: BrowserDeviceSizeId;
  onSelect: (id: BrowserDeviceSizeId) => void;
}) {
  const { t } = useTranslation();
  const selected = getBrowserDevicePreset(selectedId);
  const Icon = getDeviceIcon(selected.kind);
  const responsiveLabel = t(RESPONSIVE_BROWSER_DEVICE_LABEL_KEY);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger>
        <Pressable
          accessibilityLabel={t("workspace.browser.devices.label")}
          accessibilityRole="button"
          style={styles.deviceTrigger}
        >
          <Icon size={16} uniProps={mutedColorMapping} />
          <ThemedChevronDown size={10} uniProps={mutedColorMapping} />
        </Pressable>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" scrollable maxHeight={360}>
        {BROWSER_DEVICE_SIZE_PRESETS.map((preset) => (
          <DeviceSizeMenuItem
            key={preset.id}
            preset={preset}
            responsiveLabel={responsiveLabel}
            onSelect={onSelect}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BrowserState({ title, detail }: { title: string; detail?: string | null }) {
  return (
    <View style={styles.state} testID="android-browser-state">
      <Text style={styles.stateTitle}>{title}</Text>
      {detail ? <Text style={styles.stateDetail}>{detail}</Text> : null}
    </View>
  );
}

function BrowserLoadingState({ title }: { title: string }) {
  return (
    <View style={styles.state} testID="android-browser-loading">
      <ActivityIndicator />
      <Text style={styles.stateDetail}>{title}</Text>
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
  const elementText = truncateBrowserText(selection.text.trim().replace(/\s+/g, " "), 60);
  const elementLabel = elementText ? `${selection.tag} · ${elementText}` : selection.tag;
  const handleSubmit = useCallback(() => onSubmit({ comment }), [comment, onSubmit]);
  return (
    <View style={styles.annotationOverlay} pointerEvents="box-none">
      <View style={styles.annotationCard}>
        <View style={styles.annotationHeader}>
          <Text numberOfLines={1} style={styles.annotationTitle}>
            {t("workspace.browser.annotate.title")}
          </Text>
          <Pressable
            accessibilityLabel={t("workspace.browser.annotate.cancel")}
            accessibilityRole="button"
            onPress={onCancel}
            style={styles.annotationClose}
          >
            <ThemedX size={16} uniProps={mutedColorMapping} />
          </Pressable>
        </View>
        <Text numberOfLines={1} style={styles.annotationElement}>
          {elementLabel}
        </Text>
        <ThemedTextInput
          autoFocus
          multiline
          onChangeText={setComment}
          placeholder={t("workspace.browser.annotate.placeholder")}
          style={styles.annotationInput}
          uniProps={inputPlaceholderMapping}
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

// eslint-disable-next-line complexity
export function BrowserPane({
  browserId,
  serverId,
  workspaceId,
  cwd,
  isInteractive = false,
  isWorkspaceFocused = true,
  onFocusPane,
  onOpenUrlInBrowserTab,
  chrome = "visible",
}: BrowserPaneProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const browser = useBrowserStore((state) => state.browsersById[browserId] ?? null);
  const updateBrowser = useBrowserStore((state) => state.updateBrowser);
  const hasWorkspaceBrowser = useWorkspaceBrowserAvailability(serverId);
  const isHostConnected = useHostRuntimeIsConnected(serverId);
  const tunnelStatus = useMobileBrowserTunnelStore((state) => state.status);
  const activeServerId = useMobileBrowserTunnelStore((state) => state.activeServerId);
  const proxySession = useMobileBrowserTunnelStore((state) => state.session);
  const tunnelError = useMobileBrowserTunnelStore((state) => state.error);
  const reloadGeneration = useMobileBrowserTunnelStore((state) => state.reloadGeneration);
  const webViewRef = useRef<WebViewRef | null>(null);
  const captureTargetRef = useRef<View | null>(null);
  const selectorModeRef = useRef<SelectorMode>("annotate");
  const pendingScreenshotRef = useRef<AttachmentMetadata | undefined>(undefined);
  const lastReloadGenerationRef = useRef(reloadGeneration);
  const [draftUrl, setDraftUrl] = useState(browser?.url ?? "https://example.com");
  const [selectorMode, setSelectorMode] = useState<SelectorMode | null>(null);
  const [pendingSelection, setPendingSelection] = useState<BrowserElementSelection | null>(null);
  const [deviceSizeId, setDeviceSizeId] = useState<BrowserDeviceSizeId>("responsive");
  const [viewportSize, setViewportSize] = useState<CaptureSize>({ width: 0, height: 0 });
  const [captureSize, setCaptureSize] = useState<CaptureSize>({ width: 0, height: 0 });
  const workspaceAttachmentScopeKey = useMemo(
    () => buildBrowserAttachmentScopeKey({ cwd, serverId, workspaceId }),
    [cwd, serverId, workspaceId],
  );
  const workspaceAttachments = useWorkspaceAttachments(workspaceAttachmentScopeKey ?? "");
  const setWorkspaceAttachments = useWorkspaceAttachmentsStore(
    (state) => state.setWorkspaceAttachments,
  );
  const devicePreset = useMemo(() => getBrowserDevicePreset(deviceSizeId), [deviceSizeId]);
  const clearTransientSelection = useCallback(() => {
    pendingScreenshotRef.current = undefined;
    setPendingSelection(null);
    setSelectorMode(null);
  }, []);

  useEffect(() => {
    if (!isWorkspaceFocused || !isHostConnected || !hasWorkspaceBrowser) {
      return;
    }
    return claimMobileBrowserHost(`browser:${browserId}`, serverId);
  }, [browserId, hasWorkspaceBrowser, isHostConnected, isWorkspaceFocused, serverId]);

  useEffect(() => {
    if (isWorkspaceFocused && activeServerId === serverId && tunnelStatus === "ready") {
      return;
    }
    clearTransientSelection();
  }, [activeServerId, clearTransientSelection, isWorkspaceFocused, serverId, tunnelStatus]);

  useEffect(() => {
    setDraftUrl(browser?.url ?? "https://example.com");
  }, [browser?.url]);

  useEffect(() => {
    if (lastReloadGenerationRef.current === reloadGeneration) {
      return;
    }
    lastReloadGenerationRef.current = reloadGeneration;
    webViewRef.current?.clearHistory?.();
    webViewRef.current?.reload();
  }, [reloadGeneration]);

  useEffect(() => {
    if (!isInteractive || !browser?.canGoBack) {
      return;
    }
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      webViewRef.current?.goBack();
      return true;
    });
    return () => subscription.remove();
  }, [browser?.canGoBack, isInteractive]);

  const navigate = useCallback(
    (rawUrl: string) => {
      const url = normalizeWorkspaceBrowserUrl(rawUrl);
      const decision = resolveMobileBrowserNavigation(url);
      if (decision.kind === "localhost-tls") {
        updateBrowser(browserId, {
          isLoading: false,
          lastError: t("workspace.browser.errors.localhostHttpsUnsupported"),
        });
        return;
      }
      if (decision.kind === "invalid-url") {
        updateBrowser(browserId, {
          isLoading: false,
          lastError: t("workspace.browser.errors.invalidUrl"),
        });
        return;
      }
      if (decision.kind === "unsupported-protocol") {
        updateBrowser(browserId, {
          isLoading: false,
          lastError: t("workspace.browser.errors.unsupportedProtocol", {
            protocol: decision.protocol,
          }),
        });
        return;
      }
      if (url === browser?.url) {
        setMobileBrowserTunnelNotice(serverId, null);
        webViewRef.current?.reload();
      } else {
        setMobileBrowserTunnelNotice(serverId, null);
        updateBrowser(browserId, { url, faviconUrl: null, lastError: null, isLoading: true });
      }
      setDraftUrl(url);
    },
    [browser?.url, browserId, serverId, t, updateBrowser],
  );

  const handleSubmitUrl = useCallback(() => navigate(draftUrl), [draftUrl, navigate]);
  const handleBack = useCallback(() => webViewRef.current?.goBack(), []);
  const handleForward = useCallback(() => webViewRef.current?.goForward(), []);
  const handleRefresh = useCallback(() => {
    if (browser?.isLoading) {
      webViewRef.current?.stopLoading();
    } else {
      webViewRef.current?.reload();
    }
  }, [browser?.isLoading]);

  const handleNavigationStateChange = useCallback(
    (navigation: WebViewNavigation) => {
      const url = normalizeWorkspaceBrowserUrl(navigation.url);
      setDraftUrl(url);
      updateBrowser(browserId, {
        url,
        title: navigation.title || "",
        canGoBack: navigation.canGoBack,
        canGoForward: navigation.canGoForward,
        isLoading: navigation.loading,
        lastError: null,
      });
    },
    [browserId, updateBrowser],
  );

  const handleShouldStartLoad = useCallback(
    (request: WebViewNavigation) => {
      const decision = resolveMobileBrowserNavigation(request.url);
      if (decision.kind === "allow") {
        return true;
      }
      let message: string;
      if (decision.kind === "localhost-tls") {
        message = t("workspace.browser.errors.localhostHttpsUnsupported");
      } else if (decision.kind === "invalid-url") {
        message = t("workspace.browser.errors.invalidUrl");
      } else {
        message = t("workspace.browser.errors.unsupportedProtocol", {
          protocol: decision.protocol,
        });
      }
      updateBrowser(browserId, { isLoading: false, lastError: message });
      return false;
    },
    [browserId, t, updateBrowser],
  );

  const applyAnnotationMarkers = useCallback(() => {
    const currentUrl = browser?.url;
    if (!currentUrl) {
      return;
    }
    const markers: BrowserAnnotationMarker[] = [];
    let index = 0;
    for (const attachment of workspaceAttachments) {
      if (attachment.kind !== "browser_element") {
        continue;
      }
      index += 1;
      if (normalizeWorkspaceBrowserUrl(attachment.attachment.url) === currentUrl) {
        markers.push({ index, selector: attachment.attachment.selector });
      }
    }
    webViewRef.current?.injectJavaScript(
      markers.length > 0 ? buildAnnotationMarkerScript(markers) : CLEAR_ANNOTATION_MARKERS_SCRIPT,
    );
  }, [browser?.url, workspaceAttachments]);

  useEffect(() => {
    applyAnnotationMarkers();
  }, [applyAnnotationMarkers]);

  const cropElement = useCallback(
    async (selection: BrowserElementSelection, includeBase64: boolean) => {
      const target = captureTargetRef.current;
      if (!target || captureSize.width <= 0 || captureSize.height <= 0) {
        return null;
      }
      const uri = await captureRef(target, {
        format: "png",
        result: "tmpfile",
        width: Math.round(captureSize.width),
        height: Math.round(captureSize.height),
      });
      const x = Math.max(0, Math.min(Math.round(selection.boundingRect.x), captureSize.width - 1));
      const y = Math.max(0, Math.min(Math.round(selection.boundingRect.y), captureSize.height - 1));
      const width = Math.max(
        1,
        Math.min(Math.round(selection.boundingRect.width), Math.round(captureSize.width - x)),
      );
      const height = Math.max(
        1,
        Math.min(Math.round(selection.boundingRect.height), Math.round(captureSize.height - y)),
      );
      return await manipulateAsync(uri, [{ crop: { originX: x, originY: y, width, height } }], {
        format: SaveFormat.PNG,
        base64: includeBase64,
      });
    },
    [captureSize.height, captureSize.width],
  );

  const handleSelection = useCallback(
    async (selection: BrowserElementSelection) => {
      setSelectorMode(null);
      if (selectorModeRef.current === "screenshot") {
        try {
          const image = await cropElement(selection, true);
          if (image?.base64) {
            await Clipboard.setImageAsync(image.base64);
            toast.show(t("workspace.browser.controls.screenshotCopied"), { variant: "success" });
            return;
          }
          await Clipboard.setStringAsync(formatBrowserElementAttachment(selection));
          toast.show(t("workspace.browser.controls.elementCopied"), { variant: "success" });
        } catch (error) {
          console.warn("[browser-pane.android] screenshot failed", error);
          toast.error(t("workspace.browser.controls.screenshotFailed"));
        }
        return;
      }

      pendingScreenshotRef.current = undefined;
      try {
        const image = await cropElement(selection, false);
        if (image) {
          pendingScreenshotRef.current = await persistAttachmentFromFileUri({
            uri: image.uri,
            mimeType: "image/png",
            fileName: `element-${selection.tag}.png`,
          });
        }
      } catch (error) {
        console.warn("[browser-pane.android] element capture failed", error);
      }
      setPendingSelection(selection);
    },
    [cropElement, t, toast],
  );

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const message = parseWebViewMessage(event.nativeEvent.data);
      if (!message) {
        return;
      }
      if (message.type === "paseo-page") {
        updateBrowser(browserId, {
          title: typeof message.title === "string" ? message.title : "",
          faviconUrl: typeof message.faviconUrl === "string" ? message.faviconUrl : null,
        });
        return;
      }
      if (isBrowserElementSelection(message.selection)) {
        void handleSelection(message.selection);
      }
    },
    [browserId, handleSelection, updateBrowser],
  );

  const toggleSelector = useCallback(
    (mode: SelectorMode) => {
      if (selectorMode) {
        webViewRef.current?.injectJavaScript(DESTROY_MOBILE_BROWSER_SELECTOR_SCRIPT);
        clearTransientSelection();
        return;
      }
      if (mode === "annotate" && !workspaceAttachmentScopeKey) {
        return;
      }
      selectorModeRef.current = mode;
      setPendingSelection(null);
      pendingScreenshotRef.current = undefined;
      setSelectorMode(mode);
      webViewRef.current?.injectJavaScript(buildMobileBrowserSelectorScript());
    },
    [clearTransientSelection, selectorMode, workspaceAttachmentScopeKey],
  );
  const handleToggleAnnotation = useCallback(() => toggleSelector("annotate"), [toggleSelector]);
  const handleToggleScreenshot = useCallback(() => toggleSelector("screenshot"), [toggleSelector]);

  const submitAnnotation = useCallback(
    (annotation: BrowserElementAnnotation) => {
      const selection = pendingSelection;
      const screenshot = pendingScreenshotRef.current;
      pendingScreenshotRef.current = undefined;
      setPendingSelection(null);
      if (!selection || !workspaceAttachmentScopeKey) {
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
    [pendingSelection, setWorkspaceAttachments, workspaceAttachmentScopeKey, workspaceAttachments],
  );
  const cancelAnnotation = clearTransientSelection;

  const handleOpenWindow = useCallback(
    (event: { nativeEvent: { targetUrl: string } }) => {
      const targetUrl = normalizeWorkspaceBrowserUrl(event.nativeEvent.targetUrl);
      const decision = resolveMobileBrowserNavigation(targetUrl);
      if (decision.kind !== "allow") {
        handleShouldStartLoad({ url: targetUrl } as WebViewNavigation);
        return;
      }
      onOpenUrlInBrowserTab?.(targetUrl);
    },
    [handleShouldStartLoad, onOpenUrlInBrowserTab],
  );

  const handleViewportLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setViewportSize({ width, height });
  }, []);
  const handleCaptureLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setCaptureSize({ width, height });
  }, []);

  const frameStyle = useMemo<StyleProp<ViewStyle>>(() => {
    if (devicePreset.width === null || devicePreset.height === null) {
      return styles.responsiveFrame;
    }
    const scale = Math.min(
      1,
      viewportSize.width / devicePreset.width,
      viewportSize.height / devicePreset.height,
    );
    const renderedWidth = devicePreset.width * scale;
    const renderedHeight = devicePreset.height * scale;
    return [
      styles.fixedFrame,
      inlineUnistylesStyle({
        width: devicePreset.width,
        height: devicePreset.height,
        left: Math.max(0, (viewportSize.width - renderedWidth) / 2),
        top: Math.max(0, (viewportSize.height - renderedHeight) / 2),
        transform: [{ scale }],
        transformOrigin: "top left",
      }),
    ];
  }, [devicePreset.height, devicePreset.width, viewportSize]);

  const handleFocus = useCallback(() => {
    onFocusPane?.();
    return false;
  }, [onFocusPane]);

  const handleWebViewError = useCallback(
    (event: WebViewErrorEvent) => {
      updateBrowser(browserId, {
        isLoading: false,
        lastError: event.nativeEvent.description || t("workspace.browser.errors.failedToLoad"),
      });
    },
    [browserId, t, updateBrowser],
  );
  const handleWebViewHttpError = useCallback(
    (event: WebViewHttpErrorEvent) => {
      if (event.nativeEvent.statusCode >= 400) {
        updateBrowser(browserId, {
          lastError: `${event.nativeEvent.statusCode} ${event.nativeEvent.description}`.trim(),
        });
      }
    },
    [browserId, updateBrowser],
  );
  const handleLoadEnd = useCallback(() => {
    updateBrowser(browserId, { isLoading: false });
    webViewRef.current?.injectJavaScript(MOBILE_BROWSER_PAGE_METADATA_SCRIPT);
    applyAnnotationMarkers();
  }, [applyAnnotationMarkers, browserId, updateBrowser]);
  const handleLoadStart = useCallback(() => {
    clearTransientSelection();
    setMobileBrowserTunnelNotice(serverId, null);
    updateBrowser(browserId, { isLoading: true, lastError: null });
  }, [browserId, clearTransientSelection, serverId, updateBrowser]);
  const proxyAuthCredential = useMemo(
    () =>
      proxySession
        ? {
            host: proxySession.host,
            realm: proxySession.realm,
            username: proxySession.username,
            password: proxySession.password,
          }
        : undefined,
    [proxySession],
  );
  const webViewSource = useMemo(
    () => ({ uri: browser?.url ?? "https://example.com" }),
    [browser?.url],
  );

  if (!isWorkspaceFocused) {
    return <View style={styles.container} />;
  }
  if (!isHostConnected) {
    return <BrowserState title={t("workspace.browser.errors.hostDisconnected")} />;
  }
  if (!hasWorkspaceBrowser) {
    return <BrowserState title={t("workspace.browser.errors.updateHost")} />;
  }
  if (activeServerId !== serverId || tunnelStatus === "starting" || tunnelStatus === "idle") {
    return <BrowserLoadingState title={t("workspace.browser.errors.startingTunnel")} />;
  }
  if (tunnelStatus === "unsupported") {
    return (
      <BrowserState
        title={t("workspace.browser.errors.updateSystemWebView")}
        detail={tunnelError}
      />
    );
  }
  if (tunnelStatus === "error" || !proxySession) {
    return <BrowserState title={t("workspace.browser.errors.tunnelFailed")} detail={tunnelError} />;
  }

  const showChrome = chrome !== "hidden";
  return (
    <View
      onStartShouldSetResponder={handleFocus}
      style={styles.container}
      testID="android-workspace-browser"
    >
      {showChrome ? (
        <View style={styles.chromeRow}>
          <ToolbarButton
            label={t("workspace.browser.controls.back")}
            disabled={!browser?.canGoBack}
            onPress={handleBack}
          >
            <ThemedArrowLeft size={16} uniProps={mutedColorMapping} />
          </ToolbarButton>
          <ToolbarButton
            label={t("workspace.browser.controls.forward")}
            disabled={!browser?.canGoForward}
            onPress={handleForward}
          >
            <ThemedArrowRight size={16} uniProps={mutedColorMapping} />
          </ToolbarButton>
          <ToolbarButton
            label={
              browser?.isLoading
                ? t("workspace.browser.controls.stopLoading")
                : t("workspace.browser.controls.refresh")
            }
            onPress={handleRefresh}
          >
            <ThemedRotateCw size={16} uniProps={mutedColorMapping} />
          </ToolbarButton>
          <ThemedTextInput
            accessibilityLabel={t("workspace.browser.controls.browserUrl")}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            onChangeText={setDraftUrl}
            onSubmitEditing={handleSubmitUrl}
            placeholder={t("workspace.browser.controls.enterUrl")}
            returnKeyType="go"
            selectTextOnFocus
            style={styles.urlInput}
            uniProps={inputPlaceholderMapping}
            value={draftUrl}
          />
          <DeviceSizeMenu selectedId={deviceSizeId} onSelect={setDeviceSizeId} />
          <ToolbarButton
            label={
              selectorMode === "annotate"
                ? t("workspace.browser.controls.cancelSelector")
                : t("workspace.browser.controls.annotateElement")
            }
            active={selectorMode === "annotate"}
            disabled={!workspaceAttachmentScopeKey}
            onPress={handleToggleAnnotation}
          >
            <ThemedMousePointer2
              size={16}
              uniProps={selectorMode === "annotate" ? accentColorMapping : mutedColorMapping}
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
          >
            <ThemedCamera
              size={16}
              uniProps={selectorMode === "screenshot" ? accentColorMapping : mutedColorMapping}
            />
          </ToolbarButton>
        </View>
      ) : null}
      {browser?.lastError || tunnelError ? (
        <View style={styles.errorRow}>
          <Text numberOfLines={2} style={styles.errorText}>
            {browser?.lastError ?? tunnelError}
          </Text>
        </View>
      ) : null}
      <View onLayout={handleViewportLayout} style={styles.viewport}>
        <View
          collapsable={false}
          onLayout={handleCaptureLayout}
          ref={captureTargetRef}
          style={frameStyle}
          testID="android-browser-capture-target"
        >
          <WebView
            cacheEnabled
            domStorageEnabled
            injectedJavaScript={MOBILE_BROWSER_PAGE_METADATA_SCRIPT}
            javaScriptCanOpenWindowsAutomatically
            mixedContentMode="never"
            onError={handleWebViewError}
            onHttpError={handleWebViewHttpError}
            onLoadEnd={handleLoadEnd}
            onLoadStart={handleLoadStart}
            onMessage={handleMessage}
            onNavigationStateChange={handleNavigationStateChange}
            onOpenWindow={handleOpenWindow}
            onShouldStartLoadWithRequest={handleShouldStartLoad}
            proxyAuthCredential={proxyAuthCredential}
            ref={webViewRef}
            setSupportMultipleWindows
            source={webViewSource}
            style={styles.webview}
            testID="android-browser-webview"
            thirdPartyCookiesEnabled
          />
        </View>
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

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  chromeRow: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  iconButton: {
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  iconButtonActive: {
    backgroundColor: theme.colors.surface2,
  },
  iconButtonPressed: {
    opacity: 0.7,
  },
  iconButtonDisabled: {
    opacity: 0.4,
  },
  deviceTrigger: {
    height: 30,
    minWidth: 34,
    paddingHorizontal: theme.spacing[1],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 1,
    borderRadius: theme.borderRadius.md,
  },
  deviceLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  urlInput: {
    flex: 1,
    minWidth: 64,
    height: 30,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface1,
    fontSize: theme.fontSize.xs,
  },
  errorRow: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  errorText: {
    color: theme.colors.palette.red[500],
    fontSize: theme.fontSize.xs,
  },
  viewport: {
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
    backgroundColor: theme.colors.surface1,
  },
  responsiveFrame: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  fixedFrame: {
    position: "absolute",
    backgroundColor: theme.colors.surface0,
  },
  webview: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  state: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[4],
    backgroundColor: theme.colors.surface0,
  },
  stateTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: "600",
    textAlign: "center",
  },
  stateDetail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
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
    elevation: 8,
  },
  annotationHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  annotationTitle: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
  },
  annotationClose: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  annotationElement: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  annotationInput: {
    minHeight: 72,
    maxHeight: 140,
    padding: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface1,
    fontSize: theme.fontSize.sm,
    textAlignVertical: "top",
  },
  annotationActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
