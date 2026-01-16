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
import { usePanelStore } from "@/stores/panel-store";
import {
  AssistantMessage,
  UserMessage,
  ActivityLog,
  ToolCall,
  AgentThoughtMessage,
  TodoListCard,
  TurnCopyButton,
  MessageOuterSpacingProvider,
  type InlinePathTarget,
} from "./message";
import type { StreamItem } from "@/types/stream";
import type { PendingPermission } from "@/types/shared";
import type { AgentPermissionResponse } from "@server/server/agent/agent-sdk-types";
import type { Agent } from "@/contexts/session-context";
import { useSessionStore } from "@/stores/session-store";
import type { DaemonClientV2 } from "@server/client/daemon-client-v2";
import { parseToolCallDisplay } from "@/utils/tool-call-parsers";
import { ToolCallDetailsContent } from "./tool-call-details";
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
  const isNearBottomRef = useRef(true);
  const streamItemCountRef = useRef(0);
  const openFileExplorer = usePanelStore((state) => state.openFileExplorer);
  const setExplorerTab = usePanelStore((state) => state.setExplorerTab);

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
      openFileExplorer();
    },
    [
      agent.cwd,
      agentId,
      requestDirectoryListingOrInert,
      requestFilePreviewOrInert,
      setExplorerTab,
      openFileExplorer,
    ]
  );

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset } = event.nativeEvent;
      const threshold = Math.max(insets.bottom, 32);
      // In inverted list: scrollTop 0 = bottom, higher values = scrolled up
      const nearBottom = contentOffset.y <= threshold;

      if (isNearBottomRef.current !== nearBottom) {
        isNearBottomRef.current = nearBottom;
        setIsNearBottom(nearBottom);
      }
    },
    [insets.bottom]
  );

  const scrollToBottomInternal = useCallback(
    ({ animated }: { animated: boolean }) => {
      const list = flatListRef.current;
      if (!list) {
        return;
      }

      list.scrollToOffset({ offset: 0, animated });
      isNearBottomRef.current = true;
      setIsNearBottom(true);
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

  const collectTurnContent = useCallback(
    (index: number) => {
      const messages: string[] = [];
      // Walk backwards (older items) from current index
      // In inverted list: index+1 is the item above (older in time)
      for (let i = index; i < flatListData.length; i++) {
        const currentItem = flatListData[i];
        if (currentItem.kind === "user_message") {
          break;
        }
        if (currentItem.kind === "assistant_message") {
          messages.push(currentItem.text);
        }
      }
      // Messages are collected newest-first, reverse for chronological order
      return messages.reverse().join("\n\n");
    },
    [flatListData]
  );

  const renderStreamItem = useCallback(
    ({ item, index }: ListRenderItemInfo<StreamItem>) => {
      const content = renderStreamItemContent(item, index);
      if (!content) {
        return null;
      }

      // Check if this is the end of a turn (before a user message or end of stream when not running)
      // In inverted list: index-1 is the next item (newer in time)
      const nextItem = flatListData[index - 1];
      const isEndOfTurn =
        item.kind !== "user_message" &&
        (nextItem?.kind === "user_message" ||
          (nextItem === undefined && agent.status !== "running"));

      const getContent = () => collectTurnContent(index);

      return (
        <View style={[stylesheet.streamItemWrapper]}>
          {content}
          {isEndOfTurn ? <TurnCopyButton getContent={getContent} /> : null}
        </View>
      );
    },
    [
      getGapAbove,
      renderStreamItemContent,
      flatListData,
      agent.status,
      collectTurnContent,
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

  const toolCallDisplay = useMemo(
    () => parseToolCallDisplay(request.input, null),
    [request.input]
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
      }).catch((error) => {
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
          backgroundColor: theme.colors.surface2,
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
          <Text
            style={[
              permissionStyles.sectionTitle,
              { color: theme.colors.foregroundMuted },
            ]}
          >
            Proposed Plan
          </Text>
          <View
            style={[
              permissionStyles.contentCard,
              {
                backgroundColor: theme.colors.surface0,
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

      <ToolCallDetailsContent display={toolCallDisplay} maxHeight={200} />

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
    backgroundColor: theme.colors.surface0,
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
    backgroundColor: theme.colors.foregroundMuted,
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
