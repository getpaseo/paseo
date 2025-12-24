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
import Animated, { FadeIn, FadeOut, cancelAnimation, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSequence, withTiming } from "react-native-reanimated";
import { ChevronDown } from "lucide-react-native";
import { useRouter } from "expo-router";
import {
  AssistantMessage,
  UserMessage,
  ActivityLog,
  ToolCall,
  AgentThoughtMessage,
  TodoListCard,
  type InlinePathTarget,
} from "./message";
import { DiffViewer } from "./diff-viewer";
import type { StreamItem } from "@/types/stream";
import type { PendingPermission } from "@/types/shared";
import type { AgentPermissionResponse } from "@server/server/agent/agent-sdk-types";
import type { Agent } from "@/contexts/session-context";
import { useSessionStore } from "@/stores/session-store";
import { useDaemonRequest } from "@/hooks/use-daemon-request";
import type { UseWebSocketReturn } from "@/hooks/use-websocket";
import type { SessionOutboundMessage } from "@server/server/messages";
import {
  extractCommandDetails,
  extractEditEntries,
  extractReadEntries,
} from "@/utils/tool-call-parsers";
import { ToolCallSheetProvider } from "./tool-call-sheet";
import { createMarkdownStyles } from "@/styles/markdown-styles";

const MAX_CHAT_WIDTH = 960;
type PermissionResolvedMessage = Extract<
  SessionOutboundMessage,
  { type: "agent_permission_resolved" }
>;
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
  const insets = useSafeAreaInsets();
  const [isNearBottom, setIsNearBottom] = useState(true);
  const hasScrolledInitially = useRef(false);
  const hasAutoScrolledOnce = useRef(false);
  const isProgrammaticScrollRef = useRef(false);
  const isNearBottomRef = useRef(true);
  const isUserScrollingRef = useRef(false);
  const router = useRouter();

  // Get serverId (fallback to agent's serverId if not provided)
  const resolvedServerId = serverId ?? agent.serverId ?? "";

  // Get ws for connection status
  const ws = useSessionStore((state) => state.sessions[resolvedServerId]?.ws);

  // Get methods for file operations
  const methods = useSessionStore((state) => state.sessions[resolvedServerId]?.methods);
  const requestDirectoryListing = methods?.requestDirectoryListing;
  const requestFilePreview = methods?.requestFilePreview;

  // Create inert websocket fallback if ws is null
  const inertWebSocket = useMemo<UseWebSocketReturn>(
    () => ({
      isConnected: false,
      isConnecting: false,
      conversationId: null,
      lastError: null,
      send: () => {},
      on: () => () => {},
      sendPing: () => {},
      sendUserMessage: () => {},
      clearAgentAttention: () => {},
    }),
    []
  );
  const wsOrInert = ws ?? inertWebSocket;
  const requestDirectoryListingOrInert = requestDirectoryListing ?? (() => {});
  const requestFilePreviewOrInert = requestFilePreview ?? (() => {});
  // Keep entry/exit animations off on Android due to RN dispatchDraw crashes
  // tracked in react-native-reanimated#8422.
  const shouldDisableEntryExitAnimations = Platform.OS === "android";
  const scrollIndicatorFadeIn = shouldDisableEntryExitAnimations ? undefined : FadeIn.duration(200);
  const scrollIndicatorFadeOut = shouldDisableEntryExitAnimations ? undefined : FadeOut.duration(200);

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

      const normalized = normalizeInlinePath(target.path);
      if (!normalized) {
        return;
      }

      requestDirectoryListingOrInert(agentId, normalized.directory);
      if (normalized.file) {
        requestFilePreviewOrInert(agentId, normalized.file);
      }

      router.push({
        pathname: "/file-explorer",
        params: {
          agentId,
          path: normalized.directory,
          serverId: resolvedServerId,
          ...(normalized.file ? { file: normalized.file } : {}),
          ...(target.lineStart !== undefined
            ? { lineStart: String(target.lineStart) }
            : {}),
          ...(target.lineEnd !== undefined
            ? { lineEnd: String(target.lineEnd) }
            : {}),
        },
      });
    },
    [agentId, requestDirectoryListingOrInert, requestFilePreviewOrInert, resolvedServerId, router]
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

  function renderStreamItem({ item }: ListRenderItemInfo<StreamItem>) {
    let content: React.ReactNode = null;

    switch (item.kind) {
      case "user_message":
        content = (
          <UserMessage
            message={item.text}
            timestamp={item.timestamp.getTime()}
          />
        );
        break;

      case "assistant_message":
        content = (
          <AssistantMessage
            message={item.text}
            timestamp={item.timestamp.getTime()}
            onInlinePathPress={handleInlinePathPress}
          />
        );
        break;

      case "thought":
        content = <AgentThoughtMessage message={item.text} status={item.status} />;
        break;

      case "tool_call": {
        const { payload } = item;

        if (payload.source === "agent") {
          const data = payload.data;
          const toolLabel = data.displayName ?? `${data.server}/${data.tool}`;
          content = (
            <ToolCall
              toolName={toolLabel}
              kind={data.kind}
              args={undefined}
              result={data.result}
              error={data.error}
              status={data.status as "executing" | "completed" | "failed"}
              parsedEditEntries={data.parsedEdits}
              parsedReadEntries={data.parsedReads}
              parsedCommandDetails={data.parsedCommand ?? null}
            />
          );
        } else {
          const data = payload.data;
          content = (
            <ToolCall
              toolName={data.toolName}
              args={data.arguments}
              result={data.result}
              status={data.status}
            />
          );
        }
        break;
      }

      case "activity_log":
        content = (
          <ActivityLog
            type={item.activityType}
            message={item.message}
            timestamp={item.timestamp.getTime()}
            metadata={item.metadata}
          />
        );
        break;

      case "todo_list":
        content = (
          <TodoListCard
            provider={item.provider}
            timestamp={item.timestamp.getTime()}
            items={item.items}
          />
        );
        break;

      default:
        content = null;
    }

    if (!content) {
      return null;
    }

    return <View style={stylesheet.streamItemWrapper}>{content}</View>;
  }

  const pendingPermissionItems = useMemo(
    () =>
      Array.from(pendingPermissions.values()).filter(
        (perm) => perm.agentId === agentId
      ),
    [pendingPermissions, agentId]
  );

  const showWorkingIndicator = agent.status === "running";

  const listHeaderComponent = useMemo(() => {
    if (pendingPermissionItems.length === 0 && !showWorkingIndicator) {
      return null;
    }

    return (
      <View style={stylesheet.contentWrapper}>
        <View style={stylesheet.listHeaderContent}>
          {pendingPermissionItems.length > 0 ? (
            <View style={stylesheet.permissionsContainer}>
              {pendingPermissionItems.map((permission) => (
                <PermissionRequestCard key={permission.key} permission={permission} ws={wsOrInert} />
              ))}
            </View>
          ) : null}

          {showWorkingIndicator ? (
            <View style={stylesheet.workingIndicatorWrapper}>
              <WorkingIndicator />
            </View>
          ) : null}
        </View>
      </View>
    );
  }, [pendingPermissionItems, showWorkingIndicator, wsOrInert]);

  const flatListData = useMemo(() => {
    return [...streamItems].reverse();
  }, [streamItems]);

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

function normalizeInlinePath(rawPath: string):
  | { directory: string; file?: string }
  | null {
  if (!rawPath) {
    return null;
  }

  let value = rawPath.trim();
  value = value.replace(/^['"`]/, "").replace(/['"`]$/, "");
  if (!value) {
    return null;
  }

  let normalized = value.replace(/\\/g, "/");
  normalized = normalized.replace(/\/{2,}/g, "/");

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

  const translateDistance = -4;
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
      <Text style={stylesheet.workingIndicatorText}>Working</Text>
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
  ws,
}: {
  permission: PendingPermission;
  ws: UseWebSocketReturn;
}) {
  const { theme } = useUnistyles();

  const { request } = permission;
  const title = request.title ?? request.name ?? "Permission Required";
  const description = request.description ?? "";
  const inputPreview = request.input ? JSON.stringify(request.input, null, 2) : null;

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

  const markdownStyles = useMemo(
    () => createMarkdownStyles(theme),
    [theme]
  );

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
        <Text key={node.key} style={[inheritedStyles, styles.textgroup]} selectable>
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
        <Text key={node.key} style={[inheritedStyles, styles.code_block]} selectable>
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
        <Text key={node.key} style={[inheritedStyles, styles.code_inline]} selectable>
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
            <Text style={[contentStyle, { flex: 1, flexShrink: 1, minWidth: 0 }]} selectable>
              {children}
            </Text>
          </View>
        );
      },
    };
  }, []);

  const permissionResponse = useDaemonRequest<
    { agentId: string; requestId: string; response: AgentPermissionResponse },
    { agentId: string; requestId: string },
    PermissionResolvedMessage
  >({
    ws,
    responseType: "agent_permission_resolved",
    buildRequest: ({ params }) => ({
      type: "session",
      message: {
        type: "agent_permission_response",
        agentId: params?.agentId ?? "",
        requestId: params?.requestId ?? "",
        response: params?.response ?? { behavior: "deny" },
      },
    }),
    matchResponse: (message, context) =>
      message.payload.agentId === context.params?.agentId &&
      message.payload.requestId === context.params?.requestId,
    getRequestKey: (params) =>
      params ? `${params.agentId}:${params.requestId}` : "default",
    selectData: (message) => ({
      agentId: message.payload.agentId,
      requestId: message.payload.requestId,
    }),
    timeoutMs: 15000,
    keepPreviousData: false,
  });
  const isResponding = permissionResponse.isLoading;
  const handleResponse = useCallback(
    (response: AgentPermissionResponse) => {
      permissionResponse
        .execute({
          agentId: permission.agentId,
          requestId: permission.request.id,
          response,
        })
        .catch((error) => {
          console.error("[PermissionRequestCard] Failed to respond to permission:", error);
        });
    },
    [permission.agentId, permission.request.id, permissionResponse]
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
      <Text style={[permissionStyles.title, { color: theme.colors.foreground }]}>
        {title}
      </Text>

      {description ? (
        <Text style={[permissionStyles.description, { color: theme.colors.mutedForeground }]}>
          {description}
        </Text>
      ) : null}

      {planMarkdown ? (
        <View style={permissionStyles.section}>
          <Text style={[permissionStyles.sectionTitle, { color: theme.colors.mutedForeground }]}>Proposed Plan</Text>
          <View
            style={[
              permissionStyles.contentCard,
              {
                backgroundColor: theme.colors.background,
                borderColor: theme.colors.border,
              },
            ]}
          >
            <Markdown style={markdownStyles} rules={markdownRules}>{planMarkdown}</Markdown>
          </View>
        </View>
      ) : null}

      {commandDetails ? (
        <View style={permissionStyles.section}>
          <Text style={[permissionStyles.sectionTitle, { color: theme.colors.mutedForeground }]}>Command</Text>
          {commandDetails.command ? (
            <View style={permissionStyles.metadataRow}>
              <Text style={[permissionStyles.metadataLabel, { color: theme.colors.mutedForeground }]}>Command</Text>
              <Text style={[permissionStyles.metadataValue, { color: theme.colors.foreground }]}>
                {commandDetails.command}
              </Text>
            </View>
          ) : null}
          {commandDetails.cwd ? (
            <View style={permissionStyles.metadataRow}>
              <Text style={[permissionStyles.metadataLabel, { color: theme.colors.mutedForeground }]}>Directory</Text>
              <Text style={[permissionStyles.metadataValue, { color: theme.colors.foreground }]}>
                {commandDetails.cwd}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {editEntries.length > 0 ? (
        <View style={permissionStyles.section}>
          <Text style={[permissionStyles.sectionTitle, { color: theme.colors.mutedForeground }]}>Proposed Changes</Text>
          {editEntries.map((entry, index) => (
            <View key={`${entry.filePath ?? "change"}-${index}`} style={permissionStyles.diffSection}>
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
                  <Text style={[permissionStyles.fileBadgeText, { color: theme.colors.foreground }]}>
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
          <Text style={[permissionStyles.sectionTitle, { color: theme.colors.mutedForeground }]}>File Content</Text>
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
                    { color: theme.colors.mutedForeground, marginBottom: theme.spacing[1] },
                  ]}
                >
                  {entry.filePath}
                </Text>
              ) : null}
              <Text style={[permissionStyles.rawContentText, { color: theme.colors.foreground }]}>
                {entry.content}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {inputPreview ? (
        <View style={permissionStyles.section}>
          <Text style={[permissionStyles.sectionTitle, { color: theme.colors.mutedForeground }]}>Raw Request</Text>
          <View
            style={[
              permissionStyles.contentCard,
              {
                backgroundColor: theme.colors.background,
                borderColor: theme.colors.border,
              },
            ]}
          >
            <Text style={[permissionStyles.rawContentText, { color: theme.colors.foreground }]}>
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
            <ActivityIndicator size="small" color={theme.colors.primaryForeground} />
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
            <ActivityIndicator size="small" color={theme.colors.primaryForeground} />
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
    maxWidth: MAX_CHAT_WIDTH,
    alignSelf: "center",
  },
  list: {
    flex: 1,
    paddingHorizontal: theme.spacing[2],
  },
  streamItemWrapper: {
    width: "100%",
    maxWidth: MAX_CHAT_WIDTH,
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
  },
  workingIndicatorBubble: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: 0,
    paddingVertical: theme.spacing[1],
    paddingLeft: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    backgroundColor: "transparent",
    borderWidth: 0,
    alignSelf: "flex-start",
  },
  workingIndicatorText: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
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
    maxWidth: MAX_CHAT_WIDTH,
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
    fontFamily: "monospace",
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
    fontFamily: "monospace",
    fontSize: theme.fontSize.xs,
  },
  diffWrapper: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    overflow: "hidden",
  },
  rawContentText: {
    fontFamily: "monospace",
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
