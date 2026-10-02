import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type RefObject,
} from "react";
import {
  Image,
  PanResponder,
  Pressable,
  Text,
  View,
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  type PanResponderGestureState,
  type PointerEvent as RNPointerEvent,
  type TextInputKeyPressEventData,
} from "react-native";
import { ArrowLeft, ArrowRight, Globe, RotateCw } from "@/components/icons/ui-icons";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ExternalLink, Keyboard } from "@/components/icons/ui-icons";
import { AdaptiveTextInput } from "@/components/adaptive-text-input";
import {
  PaneContentToolbar,
  ToolbarButton,
  ToolbarControls,
  paneContentToolbarIconSize,
} from "@/components/ui/pane-content-toolbar";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { isNative, isWeb } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import { useAppSettings } from "@/hooks/use-settings";
import { useToast } from "@/contexts/toast-context";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import {
  parseEvaluatedText,
  READ_SELECTION_FUNCTION,
  TAKE_PAGE_COPY_FUNCTION,
} from "@/desktop/browser/remote-clipboard";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import {
  getBrowserRecord,
  isRemoteBrowserClosed,
  normalizeWorkspaceBrowserUrl,
  useBrowserStore,
} from "@/desktop/browser/store";
import {
  beginRemoteBrowserTabSync,
  closeLocalBrowserTab,
  syncRemoteBrowserTabs,
  whileCreatingRemoteTab,
} from "@/desktop/browser/remote-tab-sync";
import {
  isBrowserRunLocked,
  useActiveBrowserHandoff,
  useBrowserActivity,
  useBrowserActivityStore,
} from "@/desktop/browser/activity";
import { BrowserActivityBar, BrowserHandoffBar } from "@/desktop/browser/activity-bar";
import {
  getContainedFrameRect,
  getRemotePoint,
  type RemotePoint,
} from "@/desktop/browser/remote-point";
import { useRemoteBrowserFrames } from "@/desktop/browser/remote-frames";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { isHttpUrl } from "@/utils/http-url";
import { openExternalUrl } from "@/utils/open-external-url";
import type { BrowserAutomationCommand } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { DEFAULT_BROWSER_URL } from "@/desktop/browser/store/state";

interface RemoteBrowserPaneProps {
  browserId: string;
  serverId: string;
  workspaceId: string;
  isInteractive?: boolean;
  onFocusPane?: () => void;
}

interface RemoteGestureState {
  start: RemotePoint | null;
  last: RemotePoint | null;
  moved: boolean;
  longPress: boolean;
  longPressTimer: ReturnType<typeof setTimeout> | null;
}

const FRAME_REFRESH_MS = 1_000;
const SCROLL_FRAME_REFRESH_MS = 250;
const RESIZE_SETTLE_MS = 150;

const ThemedKeyboard = withUnistyles(Keyboard);
const ThemedExternalLink = withUnistyles(ExternalLink);
const mutedIconColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function websiteUrl(url: string | null | undefined): string | null {
  return url && isHttpUrl(url) ? url : null;
}

function useExternalBrowserLink(
  url: string | undefined,
  mountedRef: RefObject<boolean>,
  onError: (message: string) => void,
) {
  const [lastWebsiteUrl, setLastWebsiteUrl] = useState(websiteUrl(url));
  useEffect(() => {
    setLastWebsiteUrl((previous) => websiteUrl(url) ?? previous);
  }, [url]);
  const externalUrl = websiteUrl(url) ?? lastWebsiteUrl;
  const open = useCallback(() => {
    if (!externalUrl) return;
    void openExternalUrl(externalUrl).catch((caught: unknown) => {
      if (mountedRef.current) onError(caught instanceof Error ? caught.message : String(caught));
    });
  }, [externalUrl, mountedRef, onError]);
  return { externalUrl, open };
}

const HAS_FINE_POINTER =
  isWeb && typeof window !== "undefined" && window.matchMedia?.("(pointer: fine)").matches === true;
const DOUBLE_CLICK_MS = 400;

const REMOTE_SPECIAL_KEYS = new Set([
  "Backspace",
  "Delete",
  "Enter",
  "Escape",
  "Tab",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "Home",
  "End",
  "PageDown",
  "PageUp",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
]);

function RemoteBrowserPane({
  browserId,
  serverId,
  workspaceId,
  isInteractive = true,
  onFocusPane,
}: RemoteBrowserPaneProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const isCompact = useIsCompactFormFactor();
  const toolbarIconSize = paneContentToolbarIconSize(isCompact);
  const client = useHostRuntimeClient(serverId);
  const browser = useBrowserStore((state) => state.browsersById[browserId] ?? null);
  const updateBrowser = useBrowserStore((state) => state.updateBrowser);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [draftUrl, setDraftUrl] = useState(browser?.url ?? DEFAULT_BROWSER_URL);

  const [shownUrl, setShownUrl] = useState(draftUrl);
  const isEditingUrlRef = useRef(false);
  const recordUrl = useBrowserStore((state) => state.browsersById[browserId]?.url ?? null);
  useEffect(() => {
    if (!recordUrl || isEditingUrlRef.current) return;
    setDraftUrl(recordUrl);
    setShownUrl(recordUrl);
  }, [recordUrl]);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const onExternalError = useCallback((message: string) => setError(message), []);
  const { externalUrl, open: openExternal } = useExternalBrowserLink(
    browser?.url,
    mountedRef,
    onExternalError,
  );
  const remoteInputRef = useRef<EditingTextInputHandle | null>(null);
  const commandQueueRef = useRef(Promise.resolve());
  const pendingScrollRef = useRef<{
    browserId: string;
    point: RemotePoint;
    deltaX: number;
    deltaY: number;
  } | null>(null);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScrollFrameAtRef = useRef(0);
  const pendingHoverRef = useRef<{ browserId: string; point: RemotePoint } | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gestureRef = useRef<RemoteGestureState>({
    start: null,
    last: null,
    moved: false,
    longPress: false,
    longPressTimer: null,
  });
  const remoteBrowserId = browser?.remoteBrowserId ?? null;
  const remoteBrowserIdRef = useRef(remoteBrowserId);
  remoteBrowserIdRef.current = remoteBrowserId;
  const { frame, subscribeFrame, refreshFrame, requestedSizeRef } = useRemoteBrowserFrames({
    client,
    serverId,
    workspaceId,
    remoteBrowserId,
    remoteBrowserIdRef,
    viewportSize,
  });
  const activity = useBrowserActivity(serverId, workspaceId, remoteBrowserId);
  const handoff = useActiveBrowserHandoff(serverId, workspaceId, remoteBrowserId);
  const [handoffAction, setHandoffAction] = useState<"finish_handoff" | "cancel_handoff" | null>(
    null,
  );
  const runLocked = isBrowserRunLocked(activity);
  const canInteract = isInteractive && !runLocked;
  const frameRef = useRef(frame);
  frameRef.current = frame;
  const viewportSizeRef = useRef(viewportSize);
  viewportSizeRef.current = viewportSize;
  const frameRect = useMemo(
    () => getContainedFrameRect(frame, viewportSize),
    [frame, viewportSize],
  );
  const frameStyle = useMemo(
    () =>
      frameRect
        ? {
            position: "absolute" as const,
            left: frameRect.x,
            top: frameRect.y,
            width: frameRect.width,
            height: frameRect.height,
          }
        : undefined,
    [frameRect],
  );

  const execute = useCallback(
    async (command: BrowserAutomationCommand) => {
      if (!client) {
        throw new Error("The Linux daemon is not connected");
      }
      const response = await client.executeRemoteBrowserCommand({ workspaceId, command });
      if (!response.ok) {
        throw new Error(response.error.message);
      }
      return response.result;
    },
    [client, workspaceId],
  );

  const syncRemoteTabs = useCallback(async () => {
    const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
    if (!workspaceKey) return;
    const request = beginRemoteBrowserTabSync(workspaceKey);
    const result = await execute({ command: "list_tabs", args: {} });
    if (result.command !== "list_tabs" || !mountedRef.current) return;
    syncRemoteBrowserTabs({
      tabs: result.tabs,
      mirrorEvents: result.mirrorEvents,
      serverId,
      workspaceId,
      workspaceKey,
      request,
    });
  }, [execute, serverId, workspaceId]);

  const ensureRemoteTab = useCallback(async () => {
    if (remoteBrowserIdRef.current) {
      try {
        await refreshFrame();
        return;
      } catch {
        remoteBrowserIdRef.current = null;
        if (mountedRef.current) updateBrowser(browserId, { remoteBrowserId: null });
      }
    }
    if (!mountedRef.current) return;
    const record = getBrowserRecord(browserId);
    const result = await whileCreatingRemoteTab(() =>
      execute({
        command: "new_tab",
        args: { url: normalizeWorkspaceBrowserUrl(record?.url ?? draftUrl) },
      }),
    );
    if (result.command !== "new_tab") {
      throw new Error("The Linux browser did not create a tab");
    }
    if (!mountedRef.current) return;
    remoteBrowserIdRef.current = result.browserId;
    updateBrowser(browserId, {
      remoteBrowserId: result.browserId,
      url: result.url,
    });
    setDraftUrl(result.url);
    setShownUrl(result.url);
    await refreshFrame();
  }, [browserId, draftUrl, execute, refreshFrame, updateBrowser]);

  const handleRetry = useCallback(() => {
    if (!mountedRef.current) return;
    setError(null);
    void ensureRemoteTab()
      .then(() => syncRemoteTabs())
      .catch((caught: unknown) => {
        if (mountedRef.current) setError(caught instanceof Error ? caught.message : String(caught));
      });
  }, [ensureRemoteTab, syncRemoteTabs]);

  useEffect(() => {
    let cancelled = false;
    void ensureRemoteTab()
      .then(() => syncRemoteTabs())
      .catch((caught: unknown) => {
        if (!cancelled && mountedRef.current) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      });
    const interval = setInterval(() => {
      if (!cancelled) {
        void refreshFrame().catch((caught: unknown) => {
          if (cancelled || !mountedRef.current) return;

          const remoteId = remoteBrowserIdRef.current;
          const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
          if (remoteId && workspaceKey && isRemoteBrowserClosed(remoteId)) {
            closeLocalBrowserTab(workspaceKey, browserId);
            return;
          }
          setError(caught instanceof Error ? caught.message : String(caught));
        });
      }
    }, FRAME_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [browserId, ensureRemoteTab, refreshFrame, serverId, syncRemoteTabs, workspaceId]);

  const enqueueRemoteOperation = useCallback((operation: () => Promise<void>) => {
    commandQueueRef.current = commandQueueRef.current
      .then(() => (mountedRef.current ? operation() : undefined))
      .catch((caught: unknown) => {
        if (mountedRef.current) setError(caught instanceof Error ? caught.message : String(caught));
      });
  }, []);

  const runAndRefresh = useCallback(
    (command: BrowserAutomationCommand) => {
      enqueueRemoteOperation(async () => {
        setError(null);
        const result = await execute(command);
        if (!mountedRef.current) return;
        if (result.command === "navigate") {
          updateBrowser(browserId, { url: result.url });
          setDraftUrl(result.url);
          setShownUrl(result.url);
        }
        await refreshFrame();
      });
    },
    [browserId, enqueueRemoteOperation, execute, refreshFrame, updateBrowser],
  );

  const queueInputCommand = useCallback(
    (command: BrowserAutomationCommand) => {
      enqueueRemoteOperation(async () => {
        if (!mountedRef.current) return;
        setError(null);
        await execute(command);
        await refreshFrame();
      });
    },
    [enqueueRemoteOperation, execute, refreshFrame],
  );

  const handleRemoteInputChange = useCallback(
    (text: string) => {
      const currentBrowserId = remoteBrowserIdRef.current;
      if (currentBrowserId && text) {
        queueInputCommand({
          command: "type",
          args: { browserId: currentBrowserId, text },
        });
      }
      remoteInputRef.current?.replaceText("");
    },
    [queueInputCommand],
  );

  const queueFrameRefresh = useCallback(() => {
    enqueueRemoteOperation(async () => {
      await refreshFrame();
    });
  }, [enqueueRemoteOperation, refreshFrame]);

  const activityRefreshKey = activity
    ? `${activity.runId}:${activity.step}:${activity.phase === "paused" || activity.phase === "finished" ? activity.phase : ""}`
    : null;
  useEffect(() => {
    if (activityRefreshKey) queueFrameRefresh();
  }, [activityRefreshKey, queueFrameRefresh]);

  const handleActivityControl = useCallback(
    (action: "pause" | "resume") => {
      const currentBrowserId = remoteBrowserIdRef.current;
      if (!client || !currentBrowserId) return;
      void client
        .controlBrowserActivity({ workspaceId, browserId: currentBrowserId, action })
        .catch((caught: unknown) => {
          if (mountedRef.current)
            setError(caught instanceof Error ? caught.message : String(caught));
        });
    },
    [client, workspaceId],
  );

  const handleHandoffEnd = useCallback(
    (action: "finish_handoff" | "cancel_handoff") => {
      if (!client || !handoff) return;
      setError(null);
      setHandoffAction(action);
      void client
        .controlBrowserActivity({ workspaceId, browserId: handoff.browserId, action })
        .then((response) => {
          if (!response.applied && mountedRef.current) {
            setError(t("workspace.browser.handoff.alreadyEnded"));
          }
          return undefined;
        })
        .catch(() => {
          if (mountedRef.current) setError(t("workspace.browser.handoff.endFailed"));
        })
        .finally(() => {
          if (mountedRef.current) setHandoffAction(null);
        });
    },
    [client, handoff, t, workspaceId],
  );

  const handleActivityDismiss = useCallback(() => {
    if (activity) useBrowserActivityStore.getState().dismiss(serverId, activity);
  }, [activity, serverId]);

  const scrollInFlightRef = useRef(false);
  const lastScrollPointRef = useRef<RemotePoint | null>(null);
  const lastScrollAtRef = useRef(0);
  const flushScroll = useCallback(() => {
    if (scrollTimerRef.current) {
      clearTimeout(scrollTimerRef.current);
      scrollTimerRef.current = null;
    }
    if (scrollInFlightRef.current) return;
    const pending = pendingScrollRef.current;
    pendingScrollRef.current = null;
    if (!pending) return;
    const last = lastScrollPointRef.current;

    const moved =
      !last || Math.abs(last.x - pending.point.x) > 4 || Math.abs(last.y - pending.point.y) > 4;
    lastScrollPointRef.current = pending.point;
    scrollInFlightRef.current = true;
    void (async () => {
      try {
        await execute({
          command: "scroll",
          args: {
            browserId: pending.browserId,
            deltaX: pending.deltaX,
            deltaY: pending.deltaY,
            ...(moved ? { x: pending.point.x, y: pending.point.y } : {}),
          },
        });
        if (Date.now() - lastScrollFrameAtRef.current >= SCROLL_FRAME_REFRESH_MS) {
          lastScrollFrameAtRef.current = Date.now();
          await refreshFrame();
        }
      } catch (caught) {
        if (mountedRef.current) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        scrollInFlightRef.current = false;
        if (pendingScrollRef.current && mountedRef.current) flushScroll();
      }
    })();
  }, [execute, refreshFrame]);

  const scheduleScroll = useCallback(
    (targetBrowserId: string, point: RemotePoint, deltaX: number, deltaY: number) => {
      lastScrollAtRef.current = Date.now();
      const pending = pendingScrollRef.current;
      pendingScrollRef.current = {
        browserId: targetBrowserId,
        point,
        deltaX: (pending?.deltaX ?? 0) + deltaX,
        deltaY: (pending?.deltaY ?? 0) + deltaY,
      };
      if (scrollInFlightRef.current || scrollTimerRef.current) return;
      scrollTimerRef.current = setTimeout(() => {
        scrollTimerRef.current = null;
        flushScroll();
      }, 16);
    },
    [flushScroll],
  );

  const scheduleHover = useCallback(
    (targetBrowserId: string, point: RemotePoint) => {
      if (Date.now() - lastScrollAtRef.current < 300) return;
      pendingHoverRef.current = { browserId: targetBrowserId, point };
      if (!hoverTimerRef.current) {
        hoverTimerRef.current = setTimeout(() => {
          hoverTimerRef.current = null;
          const pending = pendingHoverRef.current;
          pendingHoverRef.current = null;
          if (!pending) return;
          enqueueRemoteOperation(async () => {
            await execute({
              command: "hover",
              args: { browserId: pending.browserId, x: pending.point.x, y: pending.point.y },
            });
          });
        }, 80);
      }
      if (hoverRefreshTimerRef.current) clearTimeout(hoverRefreshTimerRef.current);
      hoverRefreshTimerRef.current = setTimeout(() => {
        hoverRefreshTimerRef.current = null;
        queueFrameRefresh();
      }, 160);
    },
    [enqueueRemoteOperation, execute, queueFrameRefresh],
  );

  const copySelection = useCallback(
    (targetBrowserId: string) => {
      enqueueRemoteOperation(async () => {
        const selected = parseEvaluatedText(
          await execute({
            command: "evaluate",
            args: { browserId: targetBrowserId, function: READ_SELECTION_FUNCTION },
          }),
        );
        if (!selected) return;
        await copyToClipboard(selected);
        toast.copied(t("workspace.browser.copied"));
      });
    },
    [enqueueRemoteOperation, execute, t, toast],
  );

  const handleRemoteInputKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      const key = event.nativeEvent.key;
      const currentBrowserId = remoteBrowserIdRef.current;
      if (!currentBrowserId) return;
      const native = event.nativeEvent as TextInputKeyPressEventData & {
        metaKey?: boolean;
        ctrlKey?: boolean;
        preventDefault?: () => void;
      };
      if (native.metaKey || native.ctrlKey) {
        const letter = key.toLowerCase();
        if (letter === "c") {
          native.preventDefault?.();
          copySelection(currentBrowserId);
          return;
        }
        if (letter === "a") {
          native.preventDefault?.();
          queueInputCommand({
            command: "keypress",
            args: { browserId: currentBrowserId, key: "Control+A" },
          });
          return;
        }
      }
      if (!REMOTE_SPECIAL_KEYS.has(key)) return;
      queueInputCommand({
        command: "keypress",
        args: { browserId: currentBrowserId, key },
      });
    },
    [copySelection, queueInputCommand],
  );

  const handleNavigate = useCallback(() => {
    const currentBrowserId = remoteBrowserIdRef.current;
    if (!currentBrowserId) return;
    void runAndRefresh({
      command: "navigate",
      args: { browserId: currentBrowserId, url: normalizeWorkspaceBrowserUrl(draftUrl) },
    });
  }, [draftUrl, runAndRefresh]);

  const handleBack = useCallback(() => {
    const currentBrowserId = remoteBrowserIdRef.current;
    if (currentBrowserId) {
      void runAndRefresh({ command: "back", args: { browserId: currentBrowserId } });
    }
  }, [runAndRefresh]);

  const handleForward = useCallback(() => {
    const currentBrowserId = remoteBrowserIdRef.current;
    if (currentBrowserId) {
      void runAndRefresh({ command: "forward", args: { browserId: currentBrowserId } });
    }
  }, [runAndRefresh]);

  const handleReload = useCallback(() => {
    const currentBrowserId = remoteBrowserIdRef.current;
    if (currentBrowserId) {
      void runAndRefresh({ command: "reload", args: { browserId: currentBrowserId } });
    }
  }, [runAndRefresh]);

  const handleShowKeyboard = useCallback(() => {
    remoteInputRef.current?.focus();
  }, []);

  const lastClickRef = useRef<{ at: number; point: RemotePoint } | null>(null);
  const takePageCopy = useCallback(
    async (targetBrowserId: string) => {
      const copied = parseEvaluatedText(
        await execute({
          command: "evaluate",
          args: { browserId: targetBrowserId, function: TAKE_PAGE_COPY_FUNCTION },
        }),
      );
      if (copied) {
        await copyToClipboard(copied);
        toast.copied(t("workspace.browser.copied"));
      }
    },
    [execute, t, toast],
  );
  const handleFrameClick = useCallback(
    (point: RemotePoint) => {
      const currentBrowserId = remoteBrowserIdRef.current;
      if (!currentBrowserId) return;
      onFocusPane?.();
      if (isWeb && !isCompact) remoteInputRef.current?.focus();
      const last = lastClickRef.current;
      const doubleClick =
        last !== null &&
        Date.now() - last.at < DOUBLE_CLICK_MS &&
        Math.hypot(last.point.x - point.x, last.point.y - point.y) < 6;
      lastClickRef.current = doubleClick ? null : { at: Date.now(), point };
      enqueueRemoteOperation(async () => {
        await execute({
          command: "click",
          args: {
            browserId: currentBrowserId,
            ...point,
            button: "left",
            doubleClick,
            modifiers: [],
          },
        });
        await refreshFrame();
        await takePageCopy(currentBrowserId);
      });
    },
    [enqueueRemoteOperation, execute, isCompact, onFocusPane, refreshFrame, takePageCopy],
  );

  const scrollSpeed = Number(useAppSettings().settings.browserScrollSpeed);
  const scrollSpeedRef = useRef(scrollSpeed);
  scrollSpeedRef.current = scrollSpeed;
  const frameViewRef = useRef<View | null>(null);
  const hasFrame = frame !== null;
  const wheelRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const element = frameViewRef.current as unknown as HTMLElement | null;
    if (!isWeb || !element || !canInteract) return;
    const handleWheel = (event: WheelEvent) => {
      const currentBrowserId = remoteBrowserIdRef.current;
      if (!currentBrowserId) return;
      event.preventDefault();
      const bounds = element.getBoundingClientRect();
      const point = getRemotePoint(
        {
          nativeEvent: {
            offsetX: event.clientX - bounds.left,
            offsetY: event.clientY - bounds.top,
          },
        },
        frameRef.current,
        viewportSizeRef.current,
      );
      if (!point) return;

      const unit = [1, 16, bounds.height][event.deltaMode] ?? 1;
      const speed = scrollSpeedRef.current * unit;
      scheduleScroll(currentBrowserId, point, event.deltaX * speed, event.deltaY * speed);
      if (wheelRefreshTimerRef.current) clearTimeout(wheelRefreshTimerRef.current);
      wheelRefreshTimerRef.current = setTimeout(() => {
        wheelRefreshTimerRef.current = null;
        queueFrameRefresh();
      }, 120);
    };
    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      element.removeEventListener("wheel", handleWheel);
      if (wheelRefreshTimerRef.current) clearTimeout(wheelRefreshTimerRef.current);
    };
  }, [canInteract, hasFrame, queueFrameRefresh, scheduleScroll]);

  const handleFramePointerMove = useCallback(
    (event: RNPointerEvent) => {
      if (!isWeb || !canInteract) return;
      const currentBrowserId = remoteBrowserIdRef.current;
      const point = getRemotePoint(
        event as unknown as {
          nativeEvent: {
            locationX?: number;
            locationY?: number;
            offsetX?: number;
            offsetY?: number;
          };
        },
        frame,
        viewportSize,
      );
      if (currentBrowserId && point) scheduleHover(currentBrowserId, point);
    },
    [frame, canInteract, scheduleHover, viewportSize],
  );

  const handleViewportLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setViewportSize({ width, height });
  }, []);

  useEffect(() => {
    const width = Math.round(viewportSize.width);
    const height = Math.round(viewportSize.height);
    if (!remoteBrowserId || width < 50 || height < 50) return;
    const last = requestedSizeRef.current;
    if (last && last.width === width && last.height === height) return;
    if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = setTimeout(() => {
      resizeTimerRef.current = null;
      const current = requestedSizeRef.current;
      if (current && current.width === width && current.height === height) return;
      requestedSizeRef.current = { width, height };
      enqueueRemoteOperation(async () => {
        await execute({ command: "resize", args: { browserId: remoteBrowserId, width, height } });
        await refreshFrame();
      });
    }, RESIZE_SETTLE_MS);
  }, [
    enqueueRemoteOperation,
    execute,
    refreshFrame,
    remoteBrowserId,
    requestedSizeRef,
    viewportSize,
  ]);

  const handleUrlFocus = useCallback(() => {
    isEditingUrlRef.current = true;
    onFocusPane?.();
  }, [onFocusPane]);

  const handleUrlBlur = useCallback(() => {
    isEditingUrlRef.current = false;
  }, []);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => canInteract,
        onStartShouldSetPanResponderCapture: () => canInteract,
        onPanResponderGrant: (event) => {
          const point = getRemotePoint(event, frameRef.current, viewportSizeRef.current);
          const currentBrowserId = remoteBrowserIdRef.current;
          if (!point || !currentBrowserId) return;
          const gesture = gestureRef.current;
          if (gesture.longPressTimer) clearTimeout(gesture.longPressTimer);
          gestureRef.current = {
            start: point,
            last: point,
            moved: false,
            longPress: false,
            longPressTimer: setTimeout(() => {
              const current = gestureRef.current;
              if (current.start && !current.moved) current.longPress = true;
            }, 350),
          };
        },
        onPanResponderMove: (event, gestureState: PanResponderGestureState) => {
          const current = gestureRef.current;
          const point = getRemotePoint(event, frameRef.current, viewportSizeRef.current);
          const currentBrowserId = remoteBrowserIdRef.current;
          if (!current.start || !current.last || !point || !currentBrowserId) return;
          if (Math.hypot(gestureState.dx, gestureState.dy) > 8) {
            current.moved = true;
            if (!current.longPress && current.longPressTimer) {
              clearTimeout(current.longPressTimer);
              current.longPressTimer = null;
            }
          }
          if (!current.longPress && current.moved && !HAS_FINE_POINTER) {
            scheduleScroll(
              currentBrowserId,
              point,
              current.last.x - point.x,
              current.last.y - point.y,
            );
          }
          current.last = point;
        },
        onPanResponderRelease: () => {
          const current = gestureRef.current;
          if (current.longPressTimer) clearTimeout(current.longPressTimer);
          gestureRef.current = {
            start: null,
            last: null,
            moved: false,
            longPress: false,
            longPressTimer: null,
          };
          if (!current.start || !current.last) return;
          const currentBrowserId = remoteBrowserIdRef.current;
          if (!currentBrowserId) return;
          if (!current.moved) {
            handleFrameClick(current.start);
            return;
          }
          if (current.longPress || HAS_FINE_POINTER) {
            if (HAS_FINE_POINTER) remoteInputRef.current?.focus();
            enqueueRemoteOperation(async () => {
              await execute({
                command: "drag",
                args: {
                  browserId: currentBrowserId,
                  sourceX: current.start?.x ?? current.last?.x ?? 0,
                  sourceY: current.start?.y ?? current.last?.y ?? 0,
                  targetX: current.last?.x ?? current.start?.x ?? 0,
                  targetY: current.last?.y ?? current.start?.y ?? 0,
                },
              });
              await refreshFrame();
            });
            return;
          }
          flushScroll();
          queueFrameRefresh();
        },
        onPanResponderTerminate: () => {
          const current = gestureRef.current;
          if (current.longPressTimer) clearTimeout(current.longPressTimer);
          const shouldRefresh = current.moved && !current.longPress;
          gestureRef.current = {
            start: null,
            last: null,
            moved: false,
            longPress: false,
            longPressTimer: null,
          };
          if (shouldRefresh) {
            flushScroll();
            queueFrameRefresh();
          }
        },
      }),
    [
      enqueueRemoteOperation,
      execute,
      flushScroll,
      handleFrameClick,
      canInteract,
      queueFrameRefresh,
      refreshFrame,
      scheduleScroll,
    ],
  );

  useEffect(
    () => () => {
      mountedRef.current = false;
      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
      if (hoverRefreshTimerRef.current) clearTimeout(hoverRefreshTimerRef.current);
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      pendingScrollRef.current = null;
      pendingHoverRef.current = null;
      const timer = gestureRef.current.longPressTimer;
      if (timer) clearTimeout(timer);
    },
    [],
  );

  return (
    <View style={styles.container}>
      <PaneContentToolbar style={styles.toolbar}>
        <View style={styles.toolbarContent}>
          <ToolbarControls>
            <ToolbarButton
              label={t("workspace.browser.controls.back")}
              disabled={runLocked}
              onPress={handleBack}
            >
              <ArrowLeft size={toolbarIconSize} color={styles.toolbarIcon.color} />
            </ToolbarButton>
            <ToolbarButton
              label={t("workspace.browser.controls.forward")}
              disabled={runLocked}
              onPress={handleForward}
            >
              <ArrowRight size={toolbarIconSize} color={styles.toolbarIcon.color} />
            </ToolbarButton>
            <ToolbarButton
              label={t("workspace.browser.controls.refresh")}
              disabled={runLocked}
              onPress={handleReload}
            >
              <RotateCw size={toolbarIconSize} color={styles.toolbarIcon.color} />
            </ToolbarButton>
          </ToolbarControls>
          <View style={styles.urlBar}>
            <Globe size={14} color={styles.toolbarIcon.color} />
            <AdaptiveTextInput
              accessibilityLabel={t("workspace.browser.controls.browserUrl")}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!runLocked}
              initialValue={shownUrl}
              onChangeText={setDraftUrl}
              onFocus={handleUrlFocus}
              onBlur={handleUrlBlur}
              onSubmitEditing={handleNavigate}
              resetKey={`${remoteBrowserId ?? "initial"}|${shownUrl}`}
              style={styles.urlInput}
            />
          </View>
          <ToolbarControls>
            <ToolbarButton
              label={t("workspace.browser.controls.openExternal")}
              disabled={!externalUrl}
              onPress={openExternal}
              testID="remote-browser-open-external"
            >
              <ThemedExternalLink size={toolbarIconSize} uniProps={mutedIconColor} />
            </ToolbarButton>
            {isNative || isCompact ? (
              <ToolbarButton
                label={t("workspace.browser.controls.showKeyboard")}
                disabled={!canInteract}
                onPress={handleShowKeyboard}
                testID="remote-browser-keyboard"
              >
                <ThemedKeyboard size={toolbarIconSize} uniProps={mutedIconColor} />
              </ToolbarButton>
            ) : null}
          </ToolbarControls>
        </View>
      </PaneContentToolbar>
      {error ? (
        <View style={styles.errorRow}>
          <Text style={styles.error}>{error}</Text>
          <Pressable accessibilityRole="button" onPress={handleRetry} style={styles.retryButton}>
            <Text style={styles.retryLabel}>{t("common.actions.retry")}</Text>
          </Pressable>
        </View>
      ) : null}
      {handoff ? (
        <BrowserHandoffBar
          handoff={handoff}
          pendingAction={handoffAction}
          onEnd={handleHandoffEnd}
        />
      ) : null}
      {activity ? (
        <BrowserActivityBar
          activity={activity}
          onControl={handleActivityControl}
          onDismiss={handleActivityDismiss}
        />
      ) : null}
      <View onLayout={handleViewportLayout} style={styles.viewport}>
        <AdaptiveTextInput
          accessibilityLabel="Remote browser input"
          autoCapitalize="none"
          autoCorrect={false}
          caretHidden={true}
          editable={canInteract}
          initialValue=""
          multiline={false}
          onChangeText={handleRemoteInputChange}
          onKeyPress={handleRemoteInputKeyPress}
          ref={remoteInputRef}
          showSoftInputOnFocus={true}
          style={styles.remoteInput}
        />
        {frame && frameRect ? (
          <View
            {...panResponder.panHandlers}
            accessibilityLabel={t("workspace.browser.controls.browserUrl")}
            accessible={true}
            onPointerMove={isWeb ? handleFramePointerMove : undefined}
            ref={frameViewRef}
            style={styles.frameButton}
            testID={`remote-browser-frame-${browserId}`}
          >
            <RemoteFrameImage subscribe={subscribeFrame} style={frameStyle} />
          </View>
        ) : (
          <Text style={styles.status}>Connecting to Linux browser...</Text>
        )}
      </View>
    </View>
  );
}

function RemoteFrameImage({
  subscribe,
  style,
}: {
  subscribe: (listener: (dataUri: string) => void) => () => void;
  style: ComponentProps<typeof Image>["style"];
}) {
  const [uri, setUri] = useState<string | null>(null);
  useEffect(() => subscribe(setUri), [subscribe]);
  const source = useMemo(() => (uri ? { uri } : undefined), [uri]);
  return <Image fadeDuration={0} resizeMode="stretch" source={source} style={style} />;
}

export { RemoteBrowserPane };

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 },
  toolbar: { flexShrink: 0 },
  toolbarContent: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
  },
  toolbarIcon: { color: theme.colors.foregroundMuted },
  urlBar: {
    flex: 1,
    minWidth: 0,
    height: 28,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
  urlInput: {
    flex: 1,
    minWidth: 0,
    padding: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  errorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    paddingBottom: 6,
  },
  error: { flex: 1, color: theme.colors.destructive },
  retryButton: { paddingHorizontal: 8, paddingVertical: 4 },
  retryLabel: { color: theme.colors.foreground, fontWeight: "600" },
  viewport: {
    flex: 1,
    minHeight: 0,
    alignItems: "stretch",
    justifyContent: "center",
    overflow: "hidden",
  },
  remoteInput: {
    position: "absolute",
    left: 0,
    top: 0,
    width: 1,
    height: 1,
    opacity: 0.01,
    color: "transparent",
  },
  frameButton: {
    flex: 1,
    minHeight: 0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    overflow: "hidden",
  },
  frame: { width: "100%", height: "100%" },
  status: { alignSelf: "center", color: theme.colors.foregroundMuted },
}));
