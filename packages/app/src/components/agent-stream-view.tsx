import {
  Fragment,
  createElement,
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
} from "react";
import type { ComponentType, ReactElement, ReactNode } from "react";
import {
  View,
  Text,
  Pressable,
  FlatList,
  ScrollView,
  ListRenderItemInfo,
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  InteractionManager,
  Platform,
  ActivityIndicator,
} from "react-native";
import Markdown from "react-native-markdown-display";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, UnistylesRuntime, useUnistyles } from "react-native-unistyles";
import { useMutation } from "@tanstack/react-query";
import Animated, {
  FadeIn,
  FadeOut,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { Check, ChevronDown, X } from "lucide-react-native";
import { usePanelStore } from "@/stores/panel-store";
import {
  AssistantMessage,
  UserMessage,
  ActivityLog,
  ToolCall,
  TodoListCard,
  CompactionMarker,
  TurnCopyButton,
  MessageOuterSpacingProvider,
  type InlinePathTarget,
} from "./message";
import type { StreamItem } from "@/types/stream";
import type { PendingPermission } from "@/types/shared";
import type { AgentPermissionResponse } from "@server/server/agent/agent-sdk-types";
import type { Agent } from "@/contexts/session-context";
import { useSessionStore } from "@/stores/session-store";
import { useFileExplorerActions } from "@/hooks/use-file-explorer-actions";
import type { DaemonClient } from "@server/client/daemon-client";
import { ToolCallDetailsContent } from "./tool-call-details";
import { QuestionFormCard } from "./question-form-card";
import { ToolCallSheetProvider } from "./tool-call-sheet";
import {
  WebDesktopScrollbarOverlay,
  useWebDesktopScrollbarMetrics,
} from "./web-desktop-scrollbar";
import {
  collectAssistantTurnContentForStreamRenderStrategy,
  getStreamEdgeSlotProps,
  getStreamNeighborItem,
  isNearBottomForStreamRenderStrategy,
  orderHeadForStreamRenderStrategy,
  orderTailForStreamRenderStrategy,
  resolveStreamRenderStrategy,
  type StreamEdgeSlotProps,
} from "./agent-stream-render-strategy";
import { createMarkdownStyles } from "@/styles/markdown-styles";
import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import { isPerfLoggingEnabled, measurePayload, perfLog } from "@/utils/perf";
import { getMarkdownListMarker } from "@/utils/markdown-list";

const isUserMessageItem = (item?: StreamItem) => item?.kind === "user_message";
const isToolSequenceItem = (item?: StreamItem) =>
  item?.kind === "tool_call" || item?.kind === "thought" || item?.kind === "todo_list";
const AGENT_STREAM_LOG_TAG = "[AgentStreamView]";
const STREAM_ITEM_LOG_MIN_COUNT = 200;
const STREAM_ITEM_LOG_DELTA_THRESHOLD = 50;
const NOOP_SEPARATORS: ListRenderItemInfo<StreamItem>["separators"] = {
  highlight: () => {},
  unhighlight: () => {},
  updateProps: () => {},
};

function renderStreamEdgeComponent(
  component: ReactElement | ComponentType<any> | null | undefined
): ReactNode {
  if (!component) {
    return null;
  }
  if (isValidElement(component)) {
    return component;
  }
  return createElement(component);
}

export interface AgentStreamViewProps {
  agentId: string;
  serverId?: string;
  agent: Agent;
  streamItems: StreamItem[];
  pendingPermissions: Map<string, PendingPermission>;
}

export function AgentStreamView({
  agentId,
  serverId,
  agent,
  streamItems,
  pendingPermissions,
}: AgentStreamViewProps) {
  const flatListRef = useRef<FlatList<StreamItem>>(null);
  const scrollViewRef = useRef<ScrollView>(null);
  const bottomAnchorRef = useRef<View>(null);
  const { theme } = useUnistyles();
  const isMobile =
    UnistylesRuntime.breakpoint === "xs" || UnistylesRuntime.breakpoint === "sm";
  const streamRenderStrategy = useMemo(
    () =>
      resolveStreamRenderStrategy({
        platform: Platform.OS,
        isMobileBreakpoint: isMobile,
      }),
    [isMobile]
  );
  const showDesktopWebScrollbar = Platform.OS === "web" && !isMobile;
  const insets = useSafeAreaInsets();
  const [isNearBottom, setIsNearBottom] = useState(true);
  const hasScrolledInitially = useRef(false);
  const hasAutoScrolledOnce = useRef(false);
  const isNearBottomRef = useRef(true);
  const pendingAutoScrollFrameRef = useRef<number | null>(null);
  const pendingAutoScrollAnimatedRef = useRef(false);
  const scrollOffsetYRef = useRef(0);
  const streamItemCountRef = useRef(0);
  const streamViewportMetricsRef = useRef({
    contentHeight: 0,
    viewportHeight: 0,
  });
  const streamScrollbarMetrics = useWebDesktopScrollbarMetrics();
  const [expandedInlineToolCallIds, setExpandedInlineToolCallIds] = useState<Set<string>>(new Set());
  const openFileExplorer = usePanelStore((state) => state.openFileExplorer);
  const setExplorerTabForCheckout = usePanelStore((state) => state.setExplorerTabForCheckout);
  const streamRenderRefs = useMemo(
    () => ({ flatListRef, scrollViewRef, bottomAnchorRef }),
    []
  );

  // Get serverId (fallback to agent's serverId if not provided)
  const resolvedServerId = serverId ?? agent.serverId ?? "";

  const client = useSessionStore(
    (state) => state.sessions[resolvedServerId]?.client ?? null
  );
  const streamHead = useSessionStore((state) =>
    state.sessions[resolvedServerId]?.agentStreamHead?.get(agentId)
  );

  const { requestDirectoryListing, requestFilePreview, selectExplorerEntry } =
    useFileExplorerActions(resolvedServerId);
  // Keep entry/exit animations off on Android due to RN dispatchDraw crashes
  // tracked in react-native-reanimated#8422.
  const shouldDisableEntryExitAnimations = Platform.OS === "android";
  const scrollIndicatorFadeIn = shouldDisableEntryExitAnimations
    ? undefined
    : FadeIn.duration(200);
  const scrollIndicatorFadeOut = shouldDisableEntryExitAnimations
    ? undefined
    : FadeOut.duration(200);

  useEffect(() => {
    hasScrolledInitially.current = false;
    hasAutoScrolledOnce.current = false;
    isNearBottomRef.current = true;
    setExpandedInlineToolCallIds(new Set());
  }, [agentId]);

  const handleInlinePathPress = useCallback(
    (target: InlinePathTarget) => {
      if (!target.path) {
        return;
      }

      const normalized = normalizeInlinePath(target.path, agent.cwd);
      if (!normalized) {
        return;
      }

      requestDirectoryListing(agentId, normalized.directory, {
        recordHistory: false,
        setCurrentPath: false,
      });
      if (normalized.file) {
        selectExplorerEntry(agentId, normalized.file);
        requestFilePreview(agentId, normalized.file);
      }

      setExplorerTabForCheckout({
        serverId: resolvedServerId,
        cwd: agent.cwd,
        isGit: agent.projectPlacement?.checkout?.isGit ?? true,
        tab: "files",
      });
      openFileExplorer();
    },
    [
      agent.cwd,
      agentId,
      requestDirectoryListing,
      requestFilePreview,
      selectExplorerEntry,
      setExplorerTabForCheckout,
      openFileExplorer,
    ]
  );

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      scrollOffsetYRef.current = contentOffset.y;
      streamViewportMetricsRef.current = {
        contentHeight: Math.max(0, contentSize.height),
        viewportHeight: Math.max(0, layoutMeasurement.height),
      };
      const threshold = Math.max(insets.bottom, 32);
      const nearBottom = isNearBottomForStreamRenderStrategy({
        strategy: streamRenderStrategy,
        offsetY: contentOffset.y,
        threshold,
        contentHeight: streamViewportMetricsRef.current.contentHeight,
        viewportHeight: streamViewportMetricsRef.current.viewportHeight,
      });

      if (isNearBottomRef.current !== nearBottom) {
        isNearBottomRef.current = nearBottom;
        setIsNearBottom(nearBottom);
      }

      if (showDesktopWebScrollbar) {
        streamScrollbarMetrics.onScroll(event);
      }
    },
    [
      insets.bottom,
      showDesktopWebScrollbar,
      streamRenderStrategy,
      streamScrollbarMetrics,
    ]
  );

  const handleListLayout = useCallback(
    (event: LayoutChangeEvent) => {
      streamViewportMetricsRef.current = {
        ...streamViewportMetricsRef.current,
        viewportHeight: Math.max(0, event.nativeEvent.layout.height),
      };
      if (showDesktopWebScrollbar) {
        streamScrollbarMetrics.onLayout(event);
      }
    },
    [showDesktopWebScrollbar, streamScrollbarMetrics]
  );

  const scrollToBottomInternal = useCallback(
    ({ animated }: { animated: boolean }) => {
      const targetOffset = streamRenderStrategy.getBottomOffset(
        streamViewportMetricsRef.current
      );
      streamRenderStrategy.scrollToBottom({
        refs: streamRenderRefs,
        metrics: streamViewportMetricsRef.current,
        animated,
      });
      scrollOffsetYRef.current = targetOffset;
      isNearBottomRef.current = true;
      setIsNearBottom(true);
    },
    [streamRenderRefs, streamRenderStrategy]
  );

  const handleContentSizeChange = useCallback(
    (width: number, height: number) => {
      const previousMetrics = streamViewportMetricsRef.current;
      const threshold = Math.max(insets.bottom, 32);
      const wasNearBottom = isNearBottomForStreamRenderStrategy({
        strategy: streamRenderStrategy,
        offsetY: scrollOffsetYRef.current,
        threshold,
        contentHeight: previousMetrics.contentHeight,
        viewportHeight: previousMetrics.viewportHeight,
      });

      streamViewportMetricsRef.current = {
        ...previousMetrics,
        contentHeight: Math.max(0, height),
      };

      if (streamRenderStrategy.shouldAnchorBottomOnContentSizeChange()) {
        if (!hasAutoScrolledOnce.current) {
          scrollToBottomInternal({ animated: false });
          hasAutoScrolledOnce.current = true;
          hasScrolledInitially.current = true;
        } else if (wasNearBottom || isNearBottomRef.current) {
          scrollToBottomInternal({ animated: false });
        }
      }

      if (showDesktopWebScrollbar) {
        streamScrollbarMetrics.onContentSizeChange(width, height);
      }
    },
    [
      insets.bottom,
      scrollToBottomInternal,
      showDesktopWebScrollbar,
      streamRenderStrategy,
      streamScrollbarMetrics,
    ]
  );

  const scheduleAutoScroll = useCallback(
    ({ animated }: { animated: boolean }) => {
      pendingAutoScrollAnimatedRef.current =
        pendingAutoScrollAnimatedRef.current || animated;

      if (pendingAutoScrollFrameRef.current !== null) {
        return;
      }

      pendingAutoScrollFrameRef.current = requestAnimationFrame(() => {
        pendingAutoScrollFrameRef.current = null;
        const shouldAnimate = pendingAutoScrollAnimatedRef.current;
        pendingAutoScrollAnimatedRef.current = false;
        scrollToBottomInternal({ animated: shouldAnimate });
      });
    },
    [scrollToBottomInternal]
  );

  useEffect(() => {
    return () => {
      if (pendingAutoScrollFrameRef.current !== null) {
        cancelAnimationFrame(pendingAutoScrollFrameRef.current);
        pendingAutoScrollFrameRef.current = null;
      }
      pendingAutoScrollAnimatedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (streamItems.length === 0) {
      return;
    }

    if (streamRenderStrategy.shouldAnchorBottomOnContentSizeChange()) {
      // Forward streams anchor from measurement updates in handleContentSizeChange.
      return;
    }

    if (!hasAutoScrolledOnce.current) {
      const handle = InteractionManager.runAfterInteractions(() => {
        scrollToBottomInternal({ animated: false });
        hasAutoScrolledOnce.current = true;
        hasScrolledInitially.current = true;
      });
      return () => handle.cancel();
    }

    if (!isNearBottomRef.current) {
      return;
    }

    const shouldAnimate = hasScrolledInitially.current;
    scheduleAutoScroll({ animated: shouldAnimate });
    hasScrolledInitially.current = true;
  }, [
    scheduleAutoScroll,
    scrollToBottomInternal,
    streamItems,
    streamRenderStrategy,
  ]);

  function scrollToBottom() {
    const animated = streamRenderStrategy.shouldAnimateManualScrollToBottom();
    scrollToBottomInternal({ animated });
    isNearBottomRef.current = true;
    setIsNearBottom(true);
  }

  const flatListData = useMemo(() => {
    return orderTailForStreamRenderStrategy({
      strategy: streamRenderStrategy,
      streamItems,
    });
  }, [streamItems, streamRenderStrategy]);

  const orderedStreamHead = useMemo(() => {
    return orderHeadForStreamRenderStrategy({
      strategy: streamRenderStrategy,
      streamHead: streamHead ?? [],
    });
  }, [streamHead, streamRenderStrategy]);

  const tightGap = theme.spacing[1]; // 4px
  const looseGap = theme.spacing[4]; // 16px

  const getGapBelow = useCallback(
    (item: StreamItem, index: number, items: StreamItem[]) => {
      const belowItem = getStreamNeighborItem({
        strategy: streamRenderStrategy,
        items,
        index,
        relation: "below",
      });
      if (!belowItem) {
        return 0;
      }

      // Same type groups get tight gap (4px)
      if (isUserMessageItem(item) && isUserMessageItem(belowItem)) {
        return tightGap;
      }

      if (isToolSequenceItem(item) && isToolSequenceItem(belowItem)) {
        return tightGap;
      }

      // Give user messages more breathing room before tool sequences.
      if (item.kind === "user_message" && isToolSequenceItem(belowItem)) {
        return looseGap;
      }

      // Keep tool sequences visually connected to the preceding user/assistant message.
      if (
        (item.kind === "user_message" || item.kind === "assistant_message") &&
        isToolSequenceItem(belowItem)
      ) {
        return tightGap;
      }

      // Keep todo lists visually connected to the following tool sequence (symmetry).
      if (item.kind === "todo_list" && isToolSequenceItem(belowItem)) {
        return tightGap;
      }

      // Keep tool sequences visually connected to the assistant response (symmetry).
      if (isToolSequenceItem(item) && belowItem.kind === "assistant_message") {
        return tightGap;
      }

      // Different types get loose gap (16px)
      return looseGap;
    },
    [looseGap, streamRenderStrategy, tightGap]
  );

  const renderStreamItemContent = useCallback(
    (item: StreamItem, index: number, items: StreamItem[]) => {
      const handleInlineDetailsExpandedChange = (expanded: boolean) => {
        if (
          !streamRenderStrategy.shouldDisableParentScrollOnInlineDetailsExpansion()
        ) {
          return;
        }
        setExpandedInlineToolCallIds((previous) => {
          const next = new Set(previous);
          if (expanded) {
            next.add(item.id);
          } else {
            next.delete(item.id);
          }
          return next;
        });
      };

      switch (item.kind) {
        case "user_message": {
          const aboveItem = getStreamNeighborItem({
            strategy: streamRenderStrategy,
            items,
            index,
            relation: "above",
          });
          const belowItem = getStreamNeighborItem({
            strategy: streamRenderStrategy,
            items,
            index,
            relation: "below",
          });
          const isFirstInGroup = aboveItem?.kind !== "user_message";
          const isLastInGroup = belowItem?.kind !== "user_message";
          return (
            <UserMessage
              message={item.text}
              images={item.images}
              timestamp={item.timestamp.getTime()}
              isFirstInGroup={isFirstInGroup}
              isLastInGroup={isLastInGroup}
            />
          );
        }

        case "assistant_message":
          return (
            <AssistantMessage
              message={item.text}
              timestamp={item.timestamp.getTime()}
              onInlinePathPress={handleInlinePathPress}
            />
          );

        case "thought": {
          const nextItem = getStreamNeighborItem({
            strategy: streamRenderStrategy,
            items,
            index,
            relation: "below",
          });
          const isLastInSequence =
            nextItem?.kind !== "tool_call" && nextItem?.kind !== "thought";
          return (
            <ToolCall
              toolName="thinking"
              args={item.text}
              status={item.status === "ready" ? "completed" : "executing"}
              isLastInSequence={isLastInSequence}
              onInlineDetailsExpandedChange={handleInlineDetailsExpandedChange}
            />
          );
        }

        case "tool_call": {
          const { payload } = item;
          const nextItem = getStreamNeighborItem({
            strategy: streamRenderStrategy,
            items,
            index,
            relation: "below",
          });
          const isLastInSequence =
            nextItem?.kind !== "tool_call" && nextItem?.kind !== "thought";

          if (payload.source === "agent") {
            const data = payload.data;
            return (
              <ToolCall
                toolName={data.name}
                error={data.error}
                status={data.status}
                detail={data.detail}
                cwd={agent.cwd}
                metadata={data.metadata}
                isLastInSequence={isLastInSequence}
                onInlineDetailsExpandedChange={handleInlineDetailsExpandedChange}
              />
            );
          }

          const data = payload.data;
          return (
            <ToolCall
              toolName={data.toolName}
              args={data.arguments}
              result={data.result}
              status={data.status}
              isLastInSequence={isLastInSequence}
              onInlineDetailsExpandedChange={handleInlineDetailsExpandedChange}
            />
          );
        }

        case "activity_log":
          return (
            <ActivityLog
              type={item.activityType}
              message={item.message}
              timestamp={item.timestamp.getTime()}
              metadata={item.metadata}
            />
          );

        case "todo_list":
          return (
            <TodoListCard
              items={item.items}
            />
          );

        case "compaction":
          return (
            <CompactionMarker
              status={item.status}
              preTokens={item.preTokens}
            />
          );

        default:
          return null;
      }
    },
    [handleInlinePathPress, agent.cwd, streamRenderStrategy]
  );

  const renderStreamItem = useCallback(
    ({ item, index }: ListRenderItemInfo<StreamItem>) => {
      const content = renderStreamItemContent(item, index, flatListData);
      if (!content) {
        return null;
      }

      const gapBelow = getGapBelow(item, index, flatListData);
      const nextItem = getStreamNeighborItem({
        strategy: streamRenderStrategy,
        items: flatListData,
        index,
        relation: "below",
      });
      const isEndOfAssistantTurn =
        item.kind === "assistant_message" &&
        (nextItem?.kind === "user_message" ||
          (nextItem === undefined && agent.status !== "running"));
      const getTurnContent = () =>
        collectAssistantTurnContentForStreamRenderStrategy({
          strategy: streamRenderStrategy,
          items: flatListData,
          startIndex: index,
        });

      return (
        <View style={[stylesheet.streamItemWrapper, { marginBottom: gapBelow }]}>
          {content}
          {isEndOfAssistantTurn ? (
            <TurnCopyButton getContent={getTurnContent} />
          ) : null}
        </View>
      );
    },
    [
      getGapBelow,
      renderStreamItemContent,
      flatListData,
      agent.status,
      streamRenderStrategy,
    ]
  );

  const pendingPermissionItems = useMemo(
    () =>
      Array.from(pendingPermissions.values()).filter(
        (perm) => perm.agentId === agentId
      ),
    [pendingPermissions, agentId]
  );

  useEffect(() => {
    if (!isPerfLoggingEnabled()) {
      return;
    }
    const totalCount = streamItems.length;
    const prevCount = streamItemCountRef.current;
    if (totalCount === prevCount) {
      return;
    }
    const delta = Math.abs(totalCount - prevCount);
    streamItemCountRef.current = totalCount;
    if (
      totalCount < STREAM_ITEM_LOG_MIN_COUNT &&
      delta < STREAM_ITEM_LOG_DELTA_THRESHOLD
    ) {
      return;
    }
    let userCount = 0;
    let assistantCount = 0;
    let toolCallCount = 0;
    let thoughtCount = 0;
    let activityCount = 0;
    let todoCount = 0;
    for (const item of streamItems) {
      switch (item.kind) {
        case "user_message":
          userCount += 1;
          break;
        case "assistant_message":
          assistantCount += 1;
          break;
        case "tool_call":
          toolCallCount += 1;
          break;
        case "thought":
          thoughtCount += 1;
          break;
        case "activity_log":
          activityCount += 1;
          break;
        case "todo_list":
          todoCount += 1;
          break;
        default:
          break;
      }
    }
    const metrics =
      totalCount >= STREAM_ITEM_LOG_MIN_COUNT
        ? measurePayload(streamItems)
        : null;
    perfLog(AGENT_STREAM_LOG_TAG, {
      event: "stream_items",
      agentId,
      totalCount,
      userCount,
      assistantCount,
      toolCallCount,
      thoughtCount,
      activityCount,
      todoCount,
      pendingPermissionCount: pendingPermissionItems.length,
      streamHeadCount: streamHead?.length ?? 0,
      payloadApproxBytes: metrics?.approxBytes ?? 0,
      payloadFieldCount: metrics?.fieldCount ?? 0,
    });
  }, [agentId, pendingPermissionItems.length, streamHead, streamItems]);

  const showWorkingIndicator = agent.status === "running";
  const showBottomBar = showWorkingIndicator;
  const usesVirtualizedList = streamRenderStrategy.shouldUseVirtualizedList();

  const listEdgeSlotComponent = useMemo(() => {
    const hasPermissions = pendingPermissionItems.length > 0;
    const hasHeadItems = orderedStreamHead.length > 0;

    if (!hasPermissions && !showBottomBar && !hasHeadItems) {
      return null;
    }

    const leftContent = showWorkingIndicator ? <WorkingIndicator /> : null;

    return (
      <View style={stylesheet.contentWrapper}>
        <View
          style={[
            stylesheet.listHeaderContent,
            // The edge slot (header for inverted streams, footer for forward streams)
            // sits next to the newest timeline item.
            hasHeadItems ? { paddingTop: tightGap } : null,
          ]}
        >
          {hasPermissions ? (
            <View style={stylesheet.permissionsContainer}>
              {pendingPermissionItems.map((permission) => (
                <PermissionRequestCard
                  key={permission.key}
                  permission={permission}
                  client={client}
                />
              ))}
            </View>
          ) : null}

          {hasHeadItems
            ? orderedStreamHead.map((item, index) => {
                const rendered = renderStreamItemContent(
                  item,
                  index,
                  orderedStreamHead
                );
                return rendered ? (
                  <View key={item.id} style={stylesheet.streamItemWrapper}>
                    {rendered}
                  </View>
                ) : null;
              })
            : null}

          {showBottomBar ? <View style={stylesheet.bottomBarWrapper}>{leftContent}</View> : null}
        </View>
      </View>
    );
  }, [
    pendingPermissionItems,
    showWorkingIndicator,
    client,
    orderedStreamHead,
    renderStreamItemContent,
    showBottomBar,
    tightGap,
  ]);

  const flatListExtraData = useMemo(
    () => ({
      pendingPermissionCount: pendingPermissionItems.length,
      showWorkingIndicator,
      showBottomBar,
    }),
    [
      pendingPermissionItems.length,
      showWorkingIndicator,
      showBottomBar,
    ]
  );

  const listEdgeSlotProps = useMemo<StreamEdgeSlotProps>(() => {
    if (!listEdgeSlotComponent) {
      return {};
    }
    return getStreamEdgeSlotProps({
      strategy: streamRenderStrategy,
      component: listEdgeSlotComponent,
      gapSize: tightGap,
    });
  }, [listEdgeSlotComponent, streamRenderStrategy, tightGap]);

  const listEmptyComponent = useMemo(() => {
    const hasPermissions = pendingPermissionItems.length > 0;
    const hasHeadItems = orderedStreamHead.length > 0;
    if (hasPermissions || hasHeadItems) {
      return null;
    }

    const shouldShowWorking = agent.status === "running";

    if (shouldShowWorking) {
      return (
        <View style={[stylesheet.emptyState, stylesheet.contentWrapper]}>
          <ActivityIndicator
            size="small"
            color={theme.colors.foregroundMuted}
          />
          <Text style={stylesheet.emptyStateText}>Working…</Text>
        </View>
      );
    }

    return (
      <View style={[stylesheet.emptyState, stylesheet.contentWrapper]}>
        <Text style={stylesheet.emptyStateText}>
          Start chatting with this agent...
        </Text>
      </View>
    );
  }, [
    agent.status,
    pendingPermissionItems.length,
    orderedStreamHead,
    theme.colors.foregroundMuted,
  ]);

  const streamScrollEnabled =
    !streamRenderStrategy.shouldDisableParentScrollOnInlineDetailsExpansion() ||
    expandedInlineToolCallIds.size === 0;
  const listContentContainerStyle = useMemo(
    () =>
      usesVirtualizedList
        ? stylesheet.listContentContainer
        : [stylesheet.listContentContainer, stylesheet.forwardListContentContainer],
    [usesVirtualizedList]
  );
  const headerEdgeContent = renderStreamEdgeComponent(
    listEdgeSlotProps.ListHeaderComponent
  );
  const footerEdgeContent = renderStreamEdgeComponent(
    listEdgeSlotProps.ListFooterComponent
  );
  const nonVirtualizedItems = useMemo(() => {
    if (flatListData.length === 0) {
      return null;
    }

    return flatListData.map((item, index) => {
      const rendered = renderStreamItem({
        item,
        index,
        separators: NOOP_SEPARATORS,
      });
      if (!rendered) {
        return null;
      }
      return <Fragment key={item.id}>{rendered}</Fragment>;
    });
  }, [flatListData, renderStreamItem]);

  return (
    <ToolCallSheetProvider>
      <View style={stylesheet.container}>
        <MessageOuterSpacingProvider disableOuterSpacing>
          {usesVirtualizedList ? (
            <FlatList
              ref={flatListRef}
              data={flatListData}
              renderItem={renderStreamItem}
              keyExtractor={(item) => item.id}
              testID="agent-chat-scroll"
              {...listEdgeSlotProps}
              contentContainerStyle={listContentContainerStyle}
              style={stylesheet.list}
              onLayout={handleListLayout}
              onScroll={handleScroll}
              scrollEventThrottle={16}
              onContentSizeChange={handleContentSizeChange}
              ListEmptyComponent={listEmptyComponent}
              extraData={flatListExtraData}
              maintainVisibleContentPosition={
                streamRenderStrategy.getMaintainVisibleContentPosition()
              }
              initialNumToRender={12}
              windowSize={10}
              scrollEnabled={streamScrollEnabled}
              showsVerticalScrollIndicator={!showDesktopWebScrollbar}
              inverted={streamRenderStrategy.getFlatListInverted()}
            />
          ) : (
            <ScrollView
              ref={scrollViewRef}
              testID="agent-chat-scroll"
              contentContainerStyle={listContentContainerStyle}
              style={stylesheet.list}
              onLayout={handleListLayout}
              onScroll={handleScroll}
              scrollEventThrottle={16}
              onContentSizeChange={handleContentSizeChange}
              scrollEnabled={streamScrollEnabled}
              showsVerticalScrollIndicator={!showDesktopWebScrollbar}
            >
              {headerEdgeContent ? (
                <View style={listEdgeSlotProps.ListHeaderComponentStyle}>
                  {headerEdgeContent}
                </View>
              ) : null}
              {nonVirtualizedItems}
              {flatListData.length === 0 ? listEmptyComponent : null}
              {footerEdgeContent ? (
                <View style={listEdgeSlotProps.ListFooterComponentStyle}>
                  {footerEdgeContent}
                </View>
              ) : null}
              <View ref={bottomAnchorRef} collapsable={false} />
            </ScrollView>
          )}
        </MessageOuterSpacingProvider>
        <WebDesktopScrollbarOverlay
          enabled={showDesktopWebScrollbar}
          metrics={streamScrollbarMetrics}
          inverted={streamRenderStrategy.getOverlayScrollbarInverted()}
          onScrollToOffset={(nextOffset) => {
            streamRenderStrategy.scrollToOffset({
              refs: streamRenderRefs,
              offset: nextOffset,
              animated: false,
            });
          }}
        />

        {/* Scroll to bottom button */}
        {!isNearBottom && (
          <Animated.View
            style={stylesheet.scrollToBottomContainer}
            entering={scrollIndicatorFadeIn}
            exiting={scrollIndicatorFadeOut}
          >
            <View style={stylesheet.scrollToBottomInner}>
              <Pressable
                style={stylesheet.scrollToBottomButton}
                onPress={scrollToBottom}
              >
                <ChevronDown
                  size={24}
                  color={stylesheet.scrollToBottomIcon.color}
                />
              </Pressable>
            </View>
          </Animated.View>
        )}
      </View>
    </ToolCallSheetProvider>
  );
}

function normalizeInlinePath(
  rawPath: string,
  cwd?: string
): { directory: string; file?: string } | null {
  if (!rawPath) {
    return null;
  }

  const normalizedInput = normalizePathInput(rawPath);
  if (!normalizedInput) {
    return null;
  }

  let normalized = normalizedInput;
  const cwdRelative = resolvePathAgainstCwd(normalized, cwd);
  if (cwdRelative) {
    normalized = cwdRelative;
  }

  if (normalized.startsWith("./")) {
    normalized = normalized.slice(2) || ".";
  }

  if (!normalized.length) {
    normalized = ".";
  }

  if (normalized === ".") {
    return { directory: "." };
  }

  if (normalized.endsWith("/")) {
    const dir = normalized.replace(/\/+$/, "");
    return { directory: dir.length > 0 ? dir : "." };
  }

  const lastSlash = normalized.lastIndexOf("/");
  const directory = lastSlash >= 0 ? normalized.slice(0, lastSlash) : ".";

  return {
    directory: directory.length > 0 ? directory : ".",
    file: normalized,
  };
}

function normalizePathInput(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value
    .trim()
    .replace(/^['"`]/, "")
    .replace(/['"`]$/, "");
  if (!trimmed) {
    return null;
  }

  return trimmed.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

function resolvePathAgainstCwd(pathValue: string, cwd?: string): string | null {
  const normalizedCwd = normalizePathInput(cwd);
  if (
    !normalizedCwd ||
    !isAbsolutePath(pathValue) ||
    !isAbsolutePath(normalizedCwd)
  ) {
    return null;
  }

  const normalizedCwdBase = normalizedCwd.replace(/\/+$/, "") || "/";
  const comparePath = normalizePathForCompare(pathValue);
  const compareCwd = normalizePathForCompare(normalizedCwdBase);
  const prefix = normalizedCwdBase === "/" ? "/" : `${normalizedCwdBase}/`;
  const comparePrefix = normalizePathForCompare(prefix);

  if (comparePath === compareCwd) {
    return ".";
  }

  if (comparePath.startsWith(comparePrefix)) {
    return pathValue.slice(prefix.length) || ".";
  }

  return null;
}

function normalizePathForCompare(value: string): string {
  return /^[A-Za-z]:/.test(value) ? value.toLowerCase() : value;
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:\//.test(value);
}

function WorkingIndicator() {
  const dotOne = useSharedValue(0);
  const dotTwo = useSharedValue(0);
  const dotThree = useSharedValue(0);
  const bounceDuration = 600;
  const bounceDelayOffset = 160;

  useEffect(() => {
    const sharedValues = [dotOne, dotTwo, dotThree];
    sharedValues.forEach((value, index) => {
      value.value = withDelay(
        index * bounceDelayOffset,
        withRepeat(
          withSequence(
            withTiming(1, { duration: bounceDuration }),
            withTiming(0, { duration: bounceDuration })
          ),
          -1
        )
      );
    });

    return () => {
      sharedValues.forEach((value) => {
        cancelAnimation(value);
        value.value = 0;
      });
    };
  }, [dotOne, dotTwo, dotThree]);

  const translateDistance = -2;
  const dotOneStyle = useAnimatedStyle(() => ({
    opacity: 0.3 + dotOne.value * 0.7,
    transform: [{ translateY: dotOne.value * translateDistance }],
  }));

  const dotTwoStyle = useAnimatedStyle(() => ({
    opacity: 0.3 + dotTwo.value * 0.7,
    transform: [{ translateY: dotTwo.value * translateDistance }],
  }));

  const dotThreeStyle = useAnimatedStyle(() => ({
    opacity: 0.3 + dotThree.value * 0.7,
    transform: [{ translateY: dotThree.value * translateDistance }],
  }));

  return (
    <View style={stylesheet.workingIndicatorBubble}>
      <View style={stylesheet.workingDotsRow}>
        <Animated.View style={[stylesheet.workingDot, dotOneStyle]} />
        <Animated.View style={[stylesheet.workingDot, dotTwoStyle]} />
        <Animated.View style={[stylesheet.workingDot, dotThreeStyle]} />
      </View>
    </View>
  );
}

// Permission Request Card Component
function PermissionRequestCard({
  permission,
  client,
}: {
  permission: PendingPermission;
  client: DaemonClient | null;
}) {
  const { theme } = useUnistyles();
  const isMobile =
    UnistylesRuntime.breakpoint === "xs" || UnistylesRuntime.breakpoint === "sm";

  const { request } = permission;
  const isPlanRequest = request.kind === "plan";
  const title = isPlanRequest
    ? "Plan"
    : request.title ?? request.name ?? "Permission Required";
  const description = request.description ?? "";

  const planMarkdown = useMemo(() => {
    if (!request) {
      return undefined;
    }
    const planFromMetadata =
      typeof request.metadata?.planText === "string"
        ? request.metadata.planText
        : undefined;
    if (planFromMetadata) {
      return planFromMetadata;
    }
    const candidate = request.input?.["plan"];
    if (typeof candidate === "string") {
      return candidate;
    }
    return undefined;
  }, [request]);

  const markdownStyles = useMemo(() => createMarkdownStyles(theme), [theme]);

  const markdownRules = useMemo(() => {
    return {
      text: (
        node: any,
        _children: React.ReactNode[],
        _parent: any,
        styles: any,
        inheritedStyles: any = {}
      ) => (
        <Text key={node.key} style={[inheritedStyles, styles.text]}>
          {node.content}
        </Text>
      ),
      textgroup: (
        node: any,
        children: React.ReactNode[],
        _parent: any,
        styles: any,
        inheritedStyles: any = {}
      ) => (
        <Text
          key={node.key}
          style={[inheritedStyles, styles.textgroup]}
        >
          {children}
        </Text>
      ),
      code_block: (
        node: any,
        _children: React.ReactNode[],
        _parent: any,
        styles: any,
        inheritedStyles: any = {}
      ) => (
        <Text
          key={node.key}
          style={[inheritedStyles, styles.code_block]}
        >
          {node.content}
        </Text>
      ),
      fence: (
        node: any,
        _children: React.ReactNode[],
        _parent: any,
        styles: any,
        inheritedStyles: any = {}
      ) => (
        <Text key={node.key} style={[inheritedStyles, styles.fence]}>
          {node.content}
        </Text>
      ),
      code_inline: (
        node: any,
        _children: React.ReactNode[],
        _parent: any,
        styles: any,
        inheritedStyles: any = {}
      ) => (
        <Text
          key={node.key}
          style={[inheritedStyles, styles.code_inline]}
        >
          {node.content}
        </Text>
      ),
      bullet_list: (
        node: any,
        children: React.ReactNode[],
        _parent: any,
        styles: any
      ) => (
        <View key={node.key} style={styles.bullet_list}>
          {children}
        </View>
      ),
      ordered_list: (
        node: any,
        children: React.ReactNode[],
        _parent: any,
        styles: any
      ) => (
        <View key={node.key} style={styles.ordered_list}>
          {children}
        </View>
      ),
      list_item: (
        node: any,
        children: React.ReactNode[],
        parent: any,
        styles: any
      ) => {
        const { isOrdered, marker } = getMarkdownListMarker(node, parent);
        const iconStyle = isOrdered
          ? styles.ordered_list_icon
          : styles.bullet_list_icon;
        const contentStyle = isOrdered
          ? styles.ordered_list_content
          : styles.bullet_list_content;

        return (
          <View key={node.key} style={[styles.list_item, { flexShrink: 0 }]}>
            <Text style={iconStyle}>{marker}</Text>
            <Text
              style={[contentStyle, { flex: 1, flexShrink: 1, minWidth: 0 }]}
            >
              {children}
            </Text>
          </View>
        );
      },
    };
  }, []);

  const permissionMutation = useMutation({
    mutationFn: async (input: {
      agentId: string;
      requestId: string;
      response: AgentPermissionResponse;
    }) => {
      if (!client) {
        throw new Error("Daemon client unavailable");
      }
      return client.respondToPermissionAndWait(
        input.agentId,
        input.requestId,
        input.response,
        15000
      );
    },
  });
  const {
    reset: resetPermissionMutation,
    mutateAsync: respondToPermission,
    isPending: isResponding,
  } = permissionMutation;

  const [respondingAction, setRespondingAction] = useState<"accept" | "deny" | null>(null);

  useEffect(() => {
    resetPermissionMutation();
    setRespondingAction(null);
  }, [permission.request.id, resetPermissionMutation]);
  const handleResponse = useCallback(
    (response: AgentPermissionResponse) => {
      respondToPermission({
        agentId: permission.agentId,
        requestId: permission.request.id,
        response,
      }).catch((error) => {
        console.error(
          "[PermissionRequestCard] Failed to respond to permission:",
          error
        );
      });
    },
    [permission.agentId, permission.request.id, respondToPermission]
  );

  if (request.kind === "question") {
    return (
      <QuestionFormCard
        permission={permission}
        onRespond={handleResponse}
        isResponding={isResponding}
      />
    );
  }

  return (
    <View
      style={[
        permissionStyles.container,
        {
          backgroundColor: theme.colors.surface1,
          borderColor: theme.colors.border,
        },
      ]}
    >
      <Text
        style={[permissionStyles.title, { color: theme.colors.foreground }]}
      >
        {title}
      </Text>

      {description ? (
        <Text
          style={[
            permissionStyles.description,
            { color: theme.colors.foregroundMuted },
          ]}
        >
          {description}
        </Text>
      ) : null}

      {planMarkdown ? (
        <View style={permissionStyles.section}>
          {!isPlanRequest ? (
            <Text
              style={[
                permissionStyles.sectionTitle,
                { color: theme.colors.foregroundMuted },
              ]}
            >
              Proposed plan
            </Text>
          ) : null}
          <Markdown style={markdownStyles} rules={markdownRules}>
            {planMarkdown}
          </Markdown>
        </View>
      ) : null}

      {!isPlanRequest ? (
        <ToolCallDetailsContent
          detail={
            request.detail ?? {
              type: "unknown",
              input: request.input ?? null,
              output: null,
            }
          }
          maxHeight={200}
        />
      ) : null}

      <Text
        testID="permission-request-question"
        style={[
          permissionStyles.question,
          { color: theme.colors.foregroundMuted },
        ]}
      >
        How would you like to proceed?
      </Text>

      <View
        style={[
          permissionStyles.optionsContainer,
          !isMobile && permissionStyles.optionsContainerDesktop,
        ]}
      >
        <Pressable
          testID="permission-request-deny"
          style={({ pressed, hovered = false }) => [
            permissionStyles.optionButton,
            {
              backgroundColor: hovered
                ? theme.colors.surface2
                : theme.colors.surface1,
              borderColor: theme.colors.borderAccent,
            },
            pressed ? permissionStyles.optionButtonPressed : null,
          ]}
          onPress={() => {
            setRespondingAction("deny");
            handleResponse({
              behavior: "deny",
              message: "Denied by user",
            });
          }}
          disabled={isResponding}
        >
          {respondingAction === "deny" ? (
            <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
          ) : (
            <View style={permissionStyles.optionContent}>
              <X size={14} color={theme.colors.foregroundMuted} />
              <Text
                style={[
                  permissionStyles.optionText,
                  { color: theme.colors.foregroundMuted },
                ]}
              >
                Deny
              </Text>
            </View>
          )}
        </Pressable>

        <Pressable
          testID="permission-request-accept"
          style={({ pressed, hovered = false }) => [
            permissionStyles.optionButton,
            {
              backgroundColor: hovered
                ? theme.colors.surface2
                : theme.colors.surface1,
              borderColor: theme.colors.borderAccent,
            },
            pressed ? permissionStyles.optionButtonPressed : null,
          ]}
          onPress={() => {
            setRespondingAction("accept");
            handleResponse({ behavior: "allow" });
          }}
          disabled={isResponding}
        >
          {respondingAction === "accept" ? (
            <ActivityIndicator size="small" color={theme.colors.foreground} />
          ) : (
            <View style={permissionStyles.optionContent}>
              <Check size={14} color={theme.colors.foreground} />
              <Text
                style={[
                  permissionStyles.optionText,
                  { color: theme.colors.foreground },
                ]}
              >
                Accept
              </Text>
            </View>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const stylesheet = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  contentWrapper: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: "center",
  },
  listContentContainer: {
    paddingVertical: 0,
    flexGrow: 1,
    paddingHorizontal: {
      xs: theme.spacing[2],
      md: theme.spacing[4],
    },
  },
  forwardListContentContainer: {
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
  list: {
    flex: 1,
  },
  streamItemWrapper: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: "center",
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[12],
  },
  permissionsContainer: {
    gap: theme.spacing[2],
  },
  listHeaderContent: {
    gap: theme.spacing[3],
  },
  bottomBarWrapper: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    paddingLeft: 3,
    paddingRight: 3,
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[2],
    gap: theme.spacing[2],
  },
  workingIndicatorBubble: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: 0,
    paddingVertical: theme.spacing[1],
    paddingLeft: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
    backgroundColor: "transparent",
    borderWidth: 0,
    alignSelf: "flex-start",
  },
  workingDotsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  workingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.foregroundMuted,
  },
  syncingIndicator: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    paddingLeft: theme.spacing[2],
  },
  syncingIndicatorText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  invertedWrapper: {
    transform: [{ scaleY: -1 }],
    width: "100%",
  },
  emptyStateText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  scrollToBottomContainer: {
    position: "absolute",
    bottom: 16,
    left: 0,
    right: 0,
    alignItems: "center",
    pointerEvents: "box-none",
  },
  scrollToBottomInner: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: "center",
    alignItems: "center",
  },
  scrollToBottomButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
    elevation: 5,
  },
  scrollToBottomIcon: {
    color: theme.colors.foreground,
  },
}));

const permissionStyles = StyleSheet.create((theme) => ({
  container: {
    marginVertical: theme.spacing[3],
    padding: theme.spacing[3],
    borderRadius: theme.spacing[2],
    borderWidth: 1,
    gap: theme.spacing[2],
  },
  title: {
    fontSize: theme.fontSize.base,
    lineHeight: 22,
  },
  description: {
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  section: {
    gap: theme.spacing[2],
  },
  sectionTitle: {
    fontSize: theme.fontSize.xs,
  },
  question: {
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
    marginBottom: theme.spacing[1],
  },
  optionsContainer: {
    gap: theme.spacing[2],
  },
  optionsContainerDesktop: {
    flexDirection: "row",
    justifyContent: "flex-start",
    alignItems: "center",
    width: "100%",
  },
  optionButton: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    borderWidth: theme.borderWidth[1],
  },
  optionButtonPressed: {
    opacity: 0.9,
  },
  optionContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  optionText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
}));
