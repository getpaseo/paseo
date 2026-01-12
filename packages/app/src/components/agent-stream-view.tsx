import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import type { ReactNode } from "react";
import {
  View,
  Text,
  Pressable,
  FlatList,
  ListRenderItemInfo,
  NativeScrollEvent,
  NativeSyntheticEvent,
  InteractionManager,
  Platform,
  ActivityIndicator,
} from "react-native";
import Markdown from "react-native-markdown-display";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useMutation } from "@tanstack/react-query";
import { Fonts } from "@/constants/theme";
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
import { ChevronDown } from "lucide-react-native";
import { useExplorerSidebarStore } from "@/stores/explorer-sidebar-store";
import {
  AssistantMessage,
  UserMessage,
  ActivityLog,
  ToolCall,
  AgentThoughtMessage,
  TodoListCard,
  MessageOuterSpacingProvider,
  type InlinePathTarget,
} from "./message";
import { DiffViewer } from "./diff-viewer";
import type { StreamItem } from "@/types/stream";
import type { PendingPermission } from "@/types/shared";
import type { AgentPermissionResponse } from "@server/server/agent/agent-sdk-types";
import type { Agent } from "@/contexts/session-context";
import { useSessionStore } from "@/stores/session-store";
import type { DaemonClientV2 } from "@server/client/daemon-client-v2";
import {
  extractCommandDetails,
  extractEditEntries,
  extractReadEntries,
} from "@/utils/tool-call-parsers";
import { ToolCallSheetProvider } from "./tool-call-sheet";
import { createMarkdownStyles } from "@/styles/markdown-styles";
import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import { isPerfLoggingEnabled, measurePayload, perfLog } from "@/utils/perf";

const isUserMessageItem = (item?: StreamItem) => item?.kind === "user_message";
const isToolSequenceItem = (item?: StreamItem) =>
  item?.kind === "tool_call" || item?.kind === "thought";
const AGENT_STREAM_LOG_TAG = "[AgentStreamView]";
const STREAM_ITEM_LOG_MIN_COUNT = 200;
const STREAM_ITEM_LOG_DELTA_THRESHOLD = 50;
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
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const [isNearBottom, setIsNearBottom] = useState(true);
  const hasScrolledInitially = useRef(false);
  const hasAutoScrolledOnce = useRef(false);
  const isProgrammaticScrollRef = useRef(false);
  const isNearBottomRef = useRef(true);
  const isUserScrollingRef = useRef(false);
  const streamItemCountRef = useRef(0);
  const { open: openExplorer, setActiveTab: setExplorerTab } =
    useExplorerSidebarStore();

  // Get serverId (fallback to agent's serverId if not provided)
  const resolvedServerId = serverId ?? agent.serverId ?? "";

  const client = useSessionStore(
    (state) => state.sessions[resolvedServerId]?.client ?? null
  );
  const streamHead = useSessionStore((state) =>
    state.sessions[resolvedServerId]?.agentStreamHead?.get(agentId)
  );

  // Get methods for file operations
  const methods = useSessionStore(
    (state) => state.sessions[resolvedServerId]?.methods
  );
  const requestDirectoryListing = methods?.requestDirectoryListing;
  const requestFilePreview = methods?.requestFilePreview;

  const requestDirectoryListingOrInert = requestDirectoryListing ?? (() => {});
  const requestFilePreviewOrInert = requestFilePreview ?? (() => {});
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

      requestDirectoryListingOrInert(agentId, normalized.directory);
      if (normalized.file) {
        requestFilePreviewOrInert(agentId, normalized.file);
      }

      setExplorerTab("files");
      openExplorer();
    },
    [
      agent.cwd,
      agentId,
      requestDirectoryListingOrInert,
      requestFilePreviewOrInert,
      setExplorerTab,
      openExplorer,
    ]
  );

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset } = event.nativeEvent;
      const threshold = Math.max(insets.bottom, 32);
      const nearBottom = contentOffset.y <= threshold;

      if (isProgrammaticScrollRef.current) {
        if (nearBottom && !isNearBottomRef.current) {
          isNearBottomRef.current = true;
          setIsNearBottom(true);
        }
        return;
      }

      if (!nearBottom && !isUserScrollingRef.current) {
        return;
      }

      if (isNearBottomRef.current === nearBottom) {
        return;
      }

      isNearBottomRef.current = nearBottom;
      setIsNearBottom(nearBottom);
    },
    [insets.bottom]
  );

  const handleScrollBeginDrag = useCallback(() => {
    isUserScrollingRef.current = true;
  }, []);

  const handleMomentumScrollBegin = useCallback(() => {
    isUserScrollingRef.current = true;
  }, []);

  const handleScrollEnd = useCallback(() => {
    isUserScrollingRef.current = false;
  }, []);

  const scrollToBottomInternal = useCallback(
    ({ animated }: { animated: boolean }) => {
      const list = flatListRef.current;
      if (!list) {
        return;
      }

      isProgrammaticScrollRef.current = true;
      list.scrollToOffset({ offset: 0, animated });
      if (!animated) {
        isProgrammaticScrollRef.current = false;
        isNearBottomRef.current = true;
        setIsNearBottom(true);
      } else {
        setTimeout(() => {
          isProgrammaticScrollRef.current = false;
          isNearBottomRef.current = true;
          setIsNearBottom(true);
        }, 300);
      }
    },
    []
  );

  useEffect(() => {
    if (streamItems.length === 0) {
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
    scrollToBottomInternal({ animated: shouldAnimate });
    hasScrolledInitially.current = true;
  }, [streamItems, scrollToBottomInternal]);

  function scrollToBottom() {
    scrollToBottomInternal({ animated: true });
    isNearBottomRef.current = true;
    setIsNearBottom(true);
  }

  const flatListData = useMemo(() => {
    return [...streamItems].reverse();
  }, [streamItems]);

  const tightGap = theme.spacing[1]; // 4px
  const looseGap = theme.spacing[4]; // 16px

  // In inverted lists, marginBottom renders as visual gap ABOVE the item.
  // Index 0 is visually at the bottom, so use the item ABOVE (index + 1) to compute spacing.
  const getGapAbove = useCallback(
    (item: StreamItem, index: number) => {
      const aboveItem = flatListData[index + 1];
      if (!aboveItem) {
        // This is the topmost item; nothing above it visually.
        return 0;
      }

      // Same type groups get tight gap (4px)
      if (isUserMessageItem(item) && isUserMessageItem(aboveItem)) {
        return tightGap;
      }

      if (isToolSequenceItem(item) && isToolSequenceItem(aboveItem)) {
        return tightGap;
      }

      // Different types get loose gap (16px)
      return looseGap;
    },
    [flatListData, looseGap, tightGap]
  );

  const renderStreamItemContent = useCallback(
    (item: StreamItem, index: number) => {
      switch (item.kind) {
        case "user_message": {
          // In inverted list: index+1 is the item above, index-1 is below.
          const prevItem = flatListData[index + 1];
          const nextItem = flatListData[index - 1];
          const isFirstInGroup = prevItem?.kind !== "user_message";
          const isLastInGroup = nextItem?.kind !== "user_message";
          return (
            <UserMessage
              message={item.text}
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
          // In inverted list: index+1 is the item above, index-1 is below.
          const nextItem = flatListData[index - 1];
          const isLastInSequence =
            nextItem?.kind !== "tool_call" && nextItem?.kind !== "thought";
          return (
            <AgentThoughtMessage
              message={item.text}
              status={item.status}
              isLastInSequence={isLastInSequence}
            />
          );
        }

        case "tool_call": {
          const { payload } = item;
          // In inverted list: index+1 is the item above, index-1 is below.
          const nextItem = flatListData[index - 1];
          const isLastInSequence =
            nextItem?.kind !== "tool_call" && nextItem?.kind !== "thought";

          if (payload.source === "agent") {
            const data = payload.data;
            return (
              <ToolCall
                toolName={data.name}
                args={data.input}
                result={data.result}
                error={data.error}
                status={data.status as "executing" | "completed" | "failed"}
                cwd={agent.cwd}
                isLastInSequence={isLastInSequence}
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
              provider={item.provider}
              timestamp={item.timestamp.getTime()}
              items={item.items}
            />
          );

        default:
          return null;
      }
    },
    [handleInlinePathPress, agent.cwd, flatListData]
  );

  const renderStreamItem = useCallback(
    ({ item, index }: ListRenderItemInfo<StreamItem>) => {
      const content = renderStreamItemContent(item, index);
      if (!content) {
        return null;
      }

      const gap = getGapAbove(item, index);

      return (
        <View
          style={[
            stylesheet.streamItemWrapper,
            gap ? { marginBottom: gap } : null,
          ]}
        >
          {content}
        </View>
      );
    },
    [getGapAbove, renderStreamItemContent]
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
    if (totalCount < STREAM_ITEM_LOG_MIN_COUNT && delta < STREAM_ITEM_LOG_DELTA_THRESHOLD) {
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
    const metrics = totalCount >= STREAM_ITEM_LOG_MIN_COUNT ? measurePayload(streamItems) : null;
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

  const listHeaderComponent = useMemo(() => {
    const hasPermissions = pendingPermissionItems.length > 0;
    const hasHeadItems = streamHead && streamHead.length > 0;

    if (!hasPermissions && !showWorkingIndicator && !hasHeadItems) {
      return null;
    }

    return (
      <View style={stylesheet.contentWrapper}>
        <View style={stylesheet.listHeaderContent}>
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

          {showWorkingIndicator ? (
            <View style={stylesheet.workingIndicatorWrapper}>
              <WorkingIndicator />
            </View>
          ) : null}

          {hasHeadItems
            ? [...streamHead].reverse().map((item, index) => {
                const rendered = renderStreamItemContent(item, index);
                return rendered ? (
                  <View key={item.id} style={stylesheet.streamItemWrapper}>
                    {rendered}
                  </View>
                ) : null;
              })
            : null}
        </View>
      </View>
    );
  }, [
    pendingPermissionItems,
    showWorkingIndicator,
    client,
    streamHead,
    renderStreamItemContent,
  ]);

  const flatListExtraData = useMemo(
    () => ({
      pendingPermissionCount: pendingPermissionItems.length,
      showWorkingIndicator,
    }),
    [pendingPermissionItems.length, showWorkingIndicator]
  );

  return (
    <ToolCallSheetProvider>
      <View style={stylesheet.container}>
        <MessageOuterSpacingProvider disableOuterSpacing>
          <FlatList
            ref={flatListRef}
            data={flatListData}
            renderItem={renderStreamItem}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{
              paddingVertical: 0,
              flexGrow: 1,
            }}
            style={stylesheet.list}
            onScroll={handleScroll}
            onScrollBeginDrag={handleScrollBeginDrag}
            onScrollEndDrag={handleScrollEnd}
            onMomentumScrollBegin={handleMomentumScrollBegin}
            onMomentumScrollEnd={handleScrollEnd}
            scrollEventThrottle={16}
            ListEmptyComponent={
              <View style={[stylesheet.emptyState, stylesheet.contentWrapper]}>
                <Text style={stylesheet.emptyStateText}>
                  Start chatting with this agent...
                </Text>
              </View>
            }
            ListHeaderComponent={listHeaderComponent}
            extraData={flatListExtraData}
            maintainVisibleContentPosition={{
              minIndexForVisible: 0,
              autoscrollToTopThreshold: 40,
            }}
            initialNumToRender={12}
            windowSize={10}
            inverted
          />
        </MessageOuterSpacingProvider>

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
          -1,
          true
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
  client: DaemonClientV2 | null;
}) {
  const { theme } = useUnistyles();

  const { request } = permission;
  const title = request.title ?? request.name ?? "Permission Required";
  const description = request.description ?? "";
  const inputPreview = request.input
    ? JSON.stringify(request.input, null, 2)
    : null;

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

  const editEntries = useMemo(
    () => extractEditEntries(request.input, request.metadata),
    [request]
  );

  const readEntries = useMemo(
    () => extractReadEntries(request.input, request.metadata),
    [request]
  );

  const commandDetails = useMemo(
    () => extractCommandDetails(request.input, request.metadata),
    [request]
  );

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
        <Text key={node.key} style={[inheritedStyles, styles.text]} selectable>
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
          selectable
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
          selectable
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
        <Text key={node.key} style={[inheritedStyles, styles.fence]} selectable>
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
          selectable
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
        const isOrdered = parent?.type === "ordered_list";
        const index = parent?.children?.indexOf(node) ?? 0;
        const bullet = isOrdered ? `${index + 1}.` : "•";
        const iconStyle = isOrdered
          ? styles.ordered_list_icon
          : styles.bullet_list_icon;
        const contentStyle = isOrdered
          ? styles.ordered_list_content
          : styles.bullet_list_content;

        return (
          <View key={node.key} style={[styles.list_item, { flexShrink: 0 }]}>
            <Text style={iconStyle}>{bullet}</Text>
            <Text
              style={[contentStyle, { flex: 1, flexShrink: 1, minWidth: 0 }]}
              selectable
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

  useEffect(() => {
    resetPermissionMutation();
  }, [permission.request.id, resetPermissionMutation]);
  const handleResponse = useCallback(
    (response: AgentPermissionResponse) => {
      respondToPermission({
          agentId: permission.agentId,
          requestId: permission.request.id,
          response,
        })
        .catch((error) => {
        console.error(
          "[PermissionRequestCard] Failed to respond to permission:",
          error
        );
      });
    },
    [permission.agentId, permission.request.id, respondToPermission]
  );

  return (
    <View
      style={[
        permissionStyles.container,
        {
          backgroundColor: theme.colors.secondary,
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
            { color: theme.colors.mutedForeground },
          ]}
        >
          {description}
        </Text>
      ) : null}

      {planMarkdown ? (
        <View style={permissionStyles.section}>
          <Text
            style={[
              permissionStyles.sectionTitle,
              { color: theme.colors.mutedForeground },
            ]}
          >
            Proposed Plan
          </Text>
          <View
            style={[
              permissionStyles.contentCard,
              {
                backgroundColor: theme.colors.background,
                borderColor: theme.colors.border,
              },
            ]}
          >
            <Markdown style={markdownStyles} rules={markdownRules}>
              {planMarkdown}
            </Markdown>
          </View>
        </View>
      ) : null}

      {commandDetails ? (
        <View style={permissionStyles.section}>
          <Text
            style={[
              permissionStyles.sectionTitle,
              { color: theme.colors.mutedForeground },
            ]}
          >
            Command
          </Text>
          {commandDetails.command ? (
            <View style={permissionStyles.metadataRow}>
              <Text
                style={[
                  permissionStyles.metadataLabel,
                  { color: theme.colors.mutedForeground },
                ]}
              >
                Command
              </Text>
              <Text
                style={[
                  permissionStyles.metadataValue,
                  { color: theme.colors.foreground },
                ]}
              >
                {commandDetails.command}
              </Text>
            </View>
          ) : null}
          {commandDetails.cwd ? (
            <View style={permissionStyles.metadataRow}>
              <Text
                style={[
                  permissionStyles.metadataLabel,
                  { color: theme.colors.mutedForeground },
                ]}
              >
                Directory
              </Text>
              <Text
                style={[
                  permissionStyles.metadataValue,
                  { color: theme.colors.foreground },
                ]}
              >
                {commandDetails.cwd}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {editEntries.length > 0 ? (
        <View style={permissionStyles.section}>
          <Text
            style={[
              permissionStyles.sectionTitle,
              { color: theme.colors.mutedForeground },
            ]}
          >
            Proposed Changes
          </Text>
          {editEntries.map((entry, index) => (
            <View
              key={`${entry.filePath ?? "change"}-${index}`}
              style={permissionStyles.diffSection}
            >
              {entry.filePath ? (
                <View
                  style={[
                    permissionStyles.fileBadge,
                    {
                      borderColor: theme.colors.border,
                      backgroundColor: theme.colors.card,
                    },
                  ]}
                >
                  <Text
                    style={[
                      permissionStyles.fileBadgeText,
                      { color: theme.colors.foreground },
                    ]}
                  >
                    {entry.filePath}
                  </Text>
                </View>
              ) : null}
              <View
                style={[
                  permissionStyles.diffWrapper,
                  {
                    borderColor: theme.colors.border,
                    backgroundColor: theme.colors.card,
                  },
                ]}
              >
                <DiffViewer diffLines={entry.diffLines} maxHeight={200} />
              </View>
            </View>
          ))}
        </View>
      ) : null}

      {readEntries.length > 0 ? (
        <View style={permissionStyles.section}>
          <Text
            style={[
              permissionStyles.sectionTitle,
              { color: theme.colors.mutedForeground },
            ]}
          >
            File Content
          </Text>
          {readEntries.map((entry, index) => (
            <View
              key={`${entry.filePath ?? "content"}-${index}`}
              style={[
                permissionStyles.contentCard,
                {
                  backgroundColor: theme.colors.background,
                  borderColor: theme.colors.border,
                },
              ]}
            >
              {entry.filePath ? (
                <Text
                  style={[
                    permissionStyles.metadataLabel,
                    {
                      color: theme.colors.mutedForeground,
                      marginBottom: theme.spacing[1],
                    },
                  ]}
                >
                  {entry.filePath}
                </Text>
              ) : null}
              <Text
                style={[
                  permissionStyles.rawContentText,
                  { color: theme.colors.foreground },
                ]}
              >
                {entry.content}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {inputPreview ? (
        <View style={permissionStyles.section}>
          <Text
            style={[
              permissionStyles.sectionTitle,
              { color: theme.colors.mutedForeground },
            ]}
          >
            Raw Request
          </Text>
          <View
            style={[
              permissionStyles.contentCard,
              {
                backgroundColor: theme.colors.background,
                borderColor: theme.colors.border,
              },
            ]}
          >
            <Text
              style={[
                permissionStyles.rawContentText,
                { color: theme.colors.foreground },
              ]}
            >
              {inputPreview}
            </Text>
          </View>
        </View>
      ) : null}

      <Text
        style={[
          permissionStyles.question,
          { color: theme.colors.mutedForeground },
        ]}
      >
        How would you like to proceed?
      </Text>

      <View style={permissionStyles.optionsContainer}>
        <Pressable
          style={[
            permissionStyles.optionButton,
            { backgroundColor: theme.colors.primary },
          ]}
          onPress={() => handleResponse({ behavior: "allow" })}
          disabled={isResponding}
        >
          {isResponding ? (
            <ActivityIndicator
              size="small"
              color={theme.colors.primaryForeground}
            />
          ) : (
            <Text
              style={[
                permissionStyles.optionText,
                { color: theme.colors.primaryForeground },
              ]}
            >
              Allow
            </Text>
          )}
        </Pressable>
        <Pressable
          style={[
            permissionStyles.optionButton,
            { backgroundColor: theme.colors.destructive },
          ]}
          onPress={() =>
            handleResponse({
              behavior: "deny",
              message: "Denied by user",
            })
          }
          disabled={isResponding}
        >
          {isResponding ? (
            <ActivityIndicator
              size="small"
              color={theme.colors.primaryForeground}
            />
          ) : (
            <Text
              style={[
                permissionStyles.optionText,
                { color: theme.colors.primaryForeground },
              ]}
            >
              Deny
            </Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const stylesheet = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  contentWrapper: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: "center",
  },
  list: {
    flex: 1,
    paddingHorizontal: theme.spacing[2],
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
  workingIndicatorWrapper: {
    alignItems: "flex-start",
    paddingLeft: 3,
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[2],
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
    backgroundColor: theme.colors.mutedForeground,
  },
  invertedWrapper: {
    transform: [{ scaleY: -1 }],
    width: "100%",
  },
  emptyStateText: {
    color: theme.colors.mutedForeground,
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
    backgroundColor: theme.colors.muted,
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
    padding: theme.spacing[4],
    borderRadius: theme.spacing[2],
    borderWidth: 1,
    gap: theme.spacing[2],
  },
  title: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
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
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  },
  contentCard: {
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    flexShrink: 1,
    minWidth: 0,
  },
  metadataRow: {
    marginBottom: theme.spacing[2],
  },
  metadataLabel: {
    fontSize: theme.fontSize.xs,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  },
  metadataValue: {
    fontFamily: Fonts.mono,
    fontSize: theme.fontSize.sm,
  },
  diffSection: {
    gap: theme.spacing[2],
  },
  fileBadge: {
    alignSelf: "flex-start",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
  },
  fileBadgeText: {
    fontFamily: Fonts.mono,
    fontSize: theme.fontSize.xs,
  },
  diffWrapper: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    overflow: "hidden",
  },
  rawContentText: {
    fontFamily: Fonts.mono,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  question: {
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[2],
    marginBottom: theme.spacing[2],
  },
  optionsContainer: {
    gap: theme.spacing[2],
  },
  optionButton: {
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
  },
  optionText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
}));
