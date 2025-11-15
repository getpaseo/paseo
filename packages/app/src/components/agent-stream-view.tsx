import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  View,
  Text,
  Pressable,
  FlatList,
  ListRenderItemInfo,
  NativeScrollEvent,
  NativeSyntheticEvent,
  InteractionManager,
} from "react-native";
import Markdown from "react-native-markdown-display";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { BottomSheetModal } from "@gorhom/bottom-sheet";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
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
import { ToolCallBottomSheet } from "./tool-call-bottom-sheet";
import { DiffViewer } from "./diff-viewer";
import type { StreamItem } from "@/types/stream";
import type { SelectedToolCall, PendingPermission } from "@/types/shared";
import type { AgentPermissionResponse } from "@server/server/agent/agent-sdk-types";
import type { Agent } from "@/contexts/session-context";
import { useSession } from "@/contexts/session-context";
import {
  extractCommandDetails,
  extractEditEntries,
  extractReadEntries,
} from "@/utils/tool-call-parsers";

export interface AgentStreamViewProps {
  agentId: string;
  agent: Agent;
  streamItems: StreamItem[];
  pendingPermissions: Map<string, PendingPermission>;
  onPermissionResponse: (agentId: string, requestId: string, response: AgentPermissionResponse) => void;
}

export function AgentStreamView({
  agentId,
  agent,
  streamItems,
  pendingPermissions,
  onPermissionResponse,
}: AgentStreamViewProps) {
  const flatListRef = useRef<FlatList<StreamItem>>(null);
  const bottomSheetRef = useRef<BottomSheetModal | null>(null);
  const insets = useSafeAreaInsets();
  const [selectedToolCall, setSelectedToolCall] =
    useState<SelectedToolCall | null>(null);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const hasScrolledInitially = useRef(false);
  const hasAutoScrolledOnce = useRef(false);
  const isProgrammaticScrollRef = useRef(false);
  const isNearBottomRef = useRef(true);
  const isUserScrollingRef = useRef(false);
  const router = useRouter();
  const { requestDirectoryListing, requestFilePreview } = useSession();

  useEffect(() => {
    hasScrolledInitially.current = false;
    hasAutoScrolledOnce.current = false;
    isNearBottomRef.current = true;
  }, [agentId]);

  function handleOpenToolCallDetails(toolCall: SelectedToolCall) {
    setSelectedToolCall(toolCall);
    // Delay present to next frame to ensure component is mounted
    setTimeout(() => {
      bottomSheetRef.current?.present();
    }, 0);
  }

  function handleBottomSheetDismiss() {
    setSelectedToolCall(null);
  }

  const handleInlinePathPress = useCallback(
    (target: InlinePathTarget) => {
      if (!target.path) {
        return;
      }

      const normalized = normalizeInlinePath(target.path);
      if (!normalized) {
        return;
      }

      requestDirectoryListing(agentId, normalized.directory);
      if (normalized.file) {
        requestFilePreview(agentId, normalized.file);
      }

      router.push({
        pathname: "/file-explorer",
        params: {
          agentId,
          path: normalized.directory,
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
    [agentId, requestDirectoryListing, requestFilePreview, router]
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
    switch (item.kind) {
      case "user_message":
        return (
          <UserMessage
            message={item.text}
            timestamp={item.timestamp.getTime()}
          />
        );

      case "assistant_message":
        return (
          <AssistantMessage
            message={item.text}
            timestamp={item.timestamp.getTime()}
            onInlinePathPress={handleInlinePathPress}
          />
        );

      case "thought":
        return (
          <AgentThoughtMessage
            message={item.text}
          />
        );

      case "tool_call": {
        const { payload } = item;

        if (payload.source === "agent") {
          const data = payload.data;
          const toolLabel = data.displayName ?? `${data.server}/${data.tool}`;
          return (
            <ToolCall
              toolName={toolLabel}
              kind={data.kind}
              args={data.raw}
              result={data.result}
              error={data.error}
              status={data.status as "executing" | "completed" | "failed"}
              onOpenDetails={() => handleOpenToolCallDetails({ payload })}
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
            onOpenDetails={() => handleOpenToolCallDetails({ payload })}
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
  }

  const pendingPermissionItems = useMemo(
    () =>
      Array.from(pendingPermissions.values()).filter(
        (perm) => perm.agentId === agentId
      ),
    [pendingPermissions, agentId]
  );

  const flatListData = useMemo(() => {
    return [...streamItems].reverse();
  }, [streamItems]);

  return (
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
          <View style={stylesheet.emptyState}>
            <Text style={stylesheet.emptyStateText}>
              Start chatting with this agent...
            </Text>
          </View>
        }
        ListHeaderComponent={
          pendingPermissionItems.length > 0 ? (
            <View style={stylesheet.permissionsContainer}>
              {pendingPermissionItems.map((permission, index) => {
                const permissionKey = permission.request.id
                  ? `${permission.agentId}:${permission.request.id}`
                  : `${permission.agentId}:permission-${permission.request.name ?? permission.request.title ?? index}`;

                return (
                  <PermissionRequestCard
                    key={permissionKey}
                    permission={permission}
                    onResponse={onPermissionResponse}
                  />
                );
              })}
            </View>
          ) : null
        }
        extraData={pendingPermissionItems.length}
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
          entering={FadeIn.duration(200)}
          exiting={FadeOut.duration(200)}
        >
          <Pressable
            style={stylesheet.scrollToBottomButton}
            onPress={scrollToBottom}
          >
            <ChevronDown
              size={24}
              color={stylesheet.scrollToBottomIcon.color}
            />
          </Pressable>
        </Animated.View>
      )}

      <ToolCallBottomSheet
        bottomSheetRef={bottomSheetRef}
        selectedToolCall={selectedToolCall}
        onDismiss={handleBottomSheetDismiss}
      />
    </View>
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

// Permission Request Card Component
function PermissionRequestCard({
  permission,
  onResponse,
}: {
  permission: PendingPermission;
  onResponse: (agentId: string, requestId: string, response: AgentPermissionResponse) => void;
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
    () => extractEditEntries(request.input, request.metadata, request.raw),
    [request]
  );

  const readEntries = useMemo(
    () => extractReadEntries(request.input, request.metadata, request.raw),
    [request]
  );

  const commandDetails = useMemo(
    () => extractCommandDetails(request.input, request.metadata, request.raw),
    [request]
  );

  const markdownStyles = useMemo(
    () => ({
      body: {
        color: theme.colors.foreground,
        fontSize: theme.fontSize.sm,
        lineHeight: 20,
      },
      paragraph: {
        marginBottom: theme.spacing[1],
      },
      strong: {
        fontWeight: theme.fontWeight.semibold,
      },
      bullet_list: {
        marginBottom: theme.spacing[1],
      },
      ordered_list: {
        marginBottom: theme.spacing[1],
      },
      list_item: {
        flexDirection: "row" as const,
        marginBottom: theme.spacing[1],
      },
      code_inline: {
        fontFamily: "monospace",
        backgroundColor: theme.colors.card,
        paddingHorizontal: theme.spacing[1],
        paddingVertical: theme.spacing[1],
        borderRadius: theme.borderRadius.sm,
      },
      code_block: {
        fontFamily: "monospace",
        backgroundColor: theme.colors.card,
        padding: theme.spacing[2],
        borderRadius: theme.borderRadius.md,
      },
      fence: {
        fontFamily: "monospace",
        backgroundColor: theme.colors.card,
        padding: theme.spacing[2],
        borderRadius: theme.borderRadius.md,
      },
      blockquote: {
        borderLeftWidth: theme.borderWidth[1],
        borderLeftColor: theme.colors.border,
        paddingLeft: theme.spacing[3],
        marginBottom: theme.spacing[2],
      },
      blockquote_text: {
        color: theme.colors.mutedForeground,
      },
    }),
    [theme]
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
            <Markdown style={markdownStyles}>{planMarkdown}</Markdown>
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
          onPress={() =>
            onResponse(permission.agentId, request.id, { behavior: "allow" })
          }
        >
          <Text
            style={[
              permissionStyles.optionText,
              { color: theme.colors.primaryForeground },
            ]}
          >
            Allow
          </Text>
        </Pressable>
        <Pressable
          style={[
            permissionStyles.optionButton,
            { backgroundColor: theme.colors.destructive },
          ]}
          onPress={() =>
            onResponse(permission.agentId, request.id, {
              behavior: "deny",
              message: "Denied by user",
            })
          }
        >
          <Text
            style={[
              permissionStyles.optionText,
              { color: theme.colors.primaryForeground },
            ]}
          >
            Deny
          </Text>
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
  list: {
    flex: 1,
    paddingHorizontal: theme.spacing[2],
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
