import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
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
import { ArrowLeft, ArrowRight, Globe, RotateCw } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ExternalLink, Keyboard } from "lucide-react-native";
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
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import {
  getBrowserRecord,
  isRemoteBrowserClosed,
  normalizeWorkspaceBrowserUrl,
  useBrowserStore,
} from "@/desktop/browser/store";
import { duplicateRemoteBrowserRecordIds } from "@/desktop/browser/remote-tab-records";
import { collectAllTabs, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
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

// Syncs tab titles and polls old daemons' frames; frames from current daemons are pushed.
const FRAME_REFRESH_MS = 1_000;
const SCROLL_FRAME_REFRESH_MS = 250;
const RESIZE_SETTLE_MS = 150;

// The daemon lists a new tab before it answers new_tab (it waits for the page to
// load), so a listing during that window would adopt our own tab a second time.
let remoteNewTabsInFlight = 0;

function closeLocalBrowserTab(workspaceKey: string, browserId: string): void {
  const layoutStore = useWorkspaceLayoutStore.getState();
  const layout = layoutStore.layoutByWorkspace[workspaceKey];
  const tabs = layout ? collectAllTabs(layout.root) : [];
  for (const tab of tabs) {
    if (tab.target.kind === "browser" && tab.target.browserId === browserId) {
      layoutStore.closeTab(workspaceKey, tab.tabId);
    }
  }
  useBrowserStore.getState().removeBrowser(browserId);
}
const ThemedKeyboard = withUnistyles(Keyboard);
const ThemedExternalLink = withUnistyles(ExternalLink);
const mutedIconColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function isGoogleAccountPage(url: string): boolean {
  return /^https:\/\/accounts\.google\.com(?:[/:?#]|$)/i.test(url);
}

function websiteUrl(url: string | null | undefined): string | null {
  return url && isHttpUrl(url) && !isGoogleAccountPage(url) ? url : null;
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
  const isGoogleAccount = isGoogleAccountPage(url ?? "");
  const externalUrl = isGoogleAccount ? lastWebsiteUrl : websiteUrl(url);
  const open = useCallback(() => {
    if (!externalUrl) return;
    void openExternalUrl(externalUrl).catch((caught: unknown) => {
      if (mountedRef.current) onError(caught instanceof Error ? caught.message : String(caught));
    });
  }, [externalUrl, mountedRef, onError]);
  return { externalUrl, open };
}

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
  const isCompact = useIsCompactFormFactor();
  const toolbarIconSize = paneContentToolbarIconSize(isCompact);
  const client = useHostRuntimeClient(serverId);
  const browser = useBrowserStore((state) => state.browsersById[browserId] ?? null);
  const updateBrowser = useBrowserStore((state) => state.updateBrowser);
  const upsertRemoteBrowser = useBrowserStore((state) => state.upsertRemoteBrowser);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [draftUrl, setDraftUrl] = useState(browser?.url ?? "https://example.com");
  // The address field shows the tab's live URL, except while the user edits it.
  const [shownUrl, setShownUrl] = useState(draftUrl);
  const isEditingUrlRef = useRef(false);
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
  const { frame, refreshFrame, requestedSizeRef } = useRemoteBrowserFrames({
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
  const frameSource = useMemo(() => (frame ? { uri: frame.dataUri } : undefined), [frame]);
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
    const result = await execute({ command: "list_tabs", args: {} });
    if (result.command !== "list_tabs") return;
    if (!mountedRef.current) return;
    const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
    if (!workspaceKey) return;
    const layoutStore = useWorkspaceLayoutStore.getState();
    for (const duplicate of duplicateRemoteBrowserRecordIds(
      Object.values(useBrowserStore.getState().browsersById),
    )) {
      closeLocalBrowserTab(workspaceKey, duplicate);
    }
    for (const tab of result.tabs) {
      if (tab.workspaceId && tab.workspaceId !== workspaceId) continue;
      if (isRemoteBrowserClosed(tab.browserId)) continue;
      const existingRecord = Object.values(useBrowserStore.getState().browsersById).find(
        (candidate) => candidate.remoteBrowserId === tab.browserId,
      );
      if (!existingRecord) {
        if (remoteNewTabsInFlight > 0) continue;
        upsertRemoteBrowser({ browserId: tab.browserId, url: tab.url, title: tab.title });
      } else if (existingRecord.url !== tab.url || existingRecord.title !== tab.title) {
        updateBrowser(existingRecord.browserId, { url: tab.url, title: tab.title });
      }
      if (tab.browserId === remoteBrowserIdRef.current && !isEditingUrlRef.current) {
        setDraftUrl(tab.url);
        setShownUrl(tab.url);
      }
      const localBrowserId = existingRecord?.browserId ?? tab.browserId;
      const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
      const isOpen = layout
        ? collectAllTabs(layout.root).some(
            (candidate) =>
              candidate.target.kind === "browser" &&
              (candidate.target.browserId === tab.browserId ||
                candidate.target.browserId === localBrowserId),
          )
        : false;
      if (!isOpen) {
        if (!mountedRef.current) return;
        layoutStore.openTab({
          workspaceKey,
          target: { kind: "browser", browserId: tab.browserId },
          intent: "background",
        });
      }
    }
  }, [execute, serverId, updateBrowser, upsertRemoteBrowser, workspaceId]);

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
    remoteNewTabsInFlight += 1;
    let result: Awaited<ReturnType<typeof execute>>;
    try {
      result = await execute({
        command: "new_tab",
        args: { url: normalizeWorkspaceBrowserUrl(record?.url ?? draftUrl) },
      });
    } finally {
      remoteNewTabsInFlight -= 1;
    }
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
          // Closed from another tab showing the same daemon tab: follow it instead
          // of offering a retry that would open it again.
          const remoteId = remoteBrowserIdRef.current;
          const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
          if (remoteId && workspaceKey && isRemoteBrowserClosed(remoteId)) {
            closeLocalBrowserTab(workspaceKey, browserId);
            return;
          }
          setError(caught instanceof Error ? caught.message : String(caught));
        });
        void syncRemoteTabs().catch((caught: unknown) => {
          if (!cancelled && mountedRef.current) {
            setError(caught instanceof Error ? caught.message : String(caught));
          }
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

  // A new step or a pause means the run finished a browser action; the interval stays as fallback.
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

  const flushScroll = useCallback(() => {
    if (scrollTimerRef.current) {
      clearTimeout(scrollTimerRef.current);
      scrollTimerRef.current = null;
    }
    const pending = pendingScrollRef.current;
    pendingScrollRef.current = null;
    if (!pending) return;
    enqueueRemoteOperation(async () => {
      await execute({
        command: "scroll",
        args: {
          browserId: pending.browserId,
          deltaX: pending.deltaX,
          deltaY: pending.deltaY,
          x: pending.point.x,
          y: pending.point.y,
        },
      });
      if (Date.now() - lastScrollFrameAtRef.current >= SCROLL_FRAME_REFRESH_MS) {
        lastScrollFrameAtRef.current = Date.now();
        await refreshFrame();
      }
    });
  }, [enqueueRemoteOperation, execute, refreshFrame]);

  const scheduleScroll = useCallback(
    (targetBrowserId: string, point: RemotePoint, deltaX: number, deltaY: number) => {
      const pending = pendingScrollRef.current;
      pendingScrollRef.current = {
        browserId: targetBrowserId,
        point,
        deltaX: (pending?.deltaX ?? 0) + deltaX,
        deltaY: (pending?.deltaY ?? 0) + deltaY,
      };
      if (scrollTimerRef.current) return;
      scrollTimerRef.current = setTimeout(() => {
        scrollTimerRef.current = null;
        flushScroll();
      }, 32);
    },
    [flushScroll],
  );

  const scheduleHover = useCallback(
    (targetBrowserId: string, point: RemotePoint) => {
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

  const handleRemoteInputKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      const key = event.nativeEvent.key;
      const currentBrowserId = remoteBrowserIdRef.current;
      if (!currentBrowserId || !REMOTE_SPECIAL_KEYS.has(key)) return;
      queueInputCommand({
        command: "keypress",
        args: { browserId: currentBrowserId, key },
      });
    },
    [queueInputCommand],
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

  const handleFrameClick = useCallback(
    (point: RemotePoint) => {
      const currentBrowserId = remoteBrowserIdRef.current;
      if (!currentBrowserId) return;
      onFocusPane?.();
      if (isWeb && !isCompact) remoteInputRef.current?.focus();
      enqueueRemoteOperation(async () => {
        await execute({
          command: "click",
          args: {
            browserId: currentBrowserId,
            ...point,
            button: "left",
            doubleClick: false,
            modifiers: [],
          },
        });
        await refreshFrame();
      });
    },
    [enqueueRemoteOperation, execute, isCompact, onFocusPane, refreshFrame],
  );

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

  // The Linux tab keeps its own viewport; without this it stays 1280x800 and the
  // frame is stretched into whatever shape the pane has.
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
          if (!current.longPress && current.moved) {
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
          if (current.longPress) {
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
            style={styles.frameButton}
            testID={`remote-browser-frame-${browserId}`}
          >
            <Image fadeDuration={0} resizeMode="stretch" source={frameSource} style={frameStyle} />
          </View>
        ) : (
          <Text style={styles.status}>Connecting to Linux browser...</Text>
        )}
      </View>
    </View>
  );
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
