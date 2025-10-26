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
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { BottomSheetModal } from "@gorhom/bottom-sheet";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { ChevronDown } from "lucide-react-native";
import {
  AssistantMessage,
  UserMessage,
  ActivityLog,
  ToolCall,
  AgentThoughtMessage,
} from "./message";
import { ToolCallBottomSheet } from "./tool-call-bottom-sheet";
import type { StreamItem } from "@/types/stream";
import type { SelectedToolCall, PendingPermission } from "@/types/shared";
import type { Agent } from "@/contexts/session-context";

export interface AgentStreamViewProps {
  agentId: string;
  agent: Agent;
  streamItems: StreamItem[];
  pendingPermissions: Map<string, PendingPermission>;
  onPermissionResponse: (requestId: string, optionId: string) => void;
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

        // Extract data based on source
        if (payload.source === "acp") {
          const data = payload.data;
          // Map ACP status to display status
          const toolStatus =
            data.status === "pending" || data.status === "in_progress"
              ? ("executing" as const)
              : data.status === "completed"
              ? ("completed" as const)
              : ("failed" as const);

          return (
            <ToolCall
              toolName={data.title ?? "Unknown Tool"}
              kind={data.kind}
              args={data.rawInput}
              result={data.rawOutput}
              status={toolStatus}
              onOpenDetails={() => handleOpenToolCallDetails({ payload })}
            />
          );
        }

        // Orchestrator tool call
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

      case "plan":
      case "activity_log":
      case "artifact":
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
              {pendingPermissionItems.map((permission) => (
                <PermissionRequestCard
                  key={permission.requestId}
                  permission={permission}
                  onResponse={onPermissionResponse}
                />
              ))}
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

// Permission Request Card Component
function PermissionRequestCard({
  permission,
  onResponse,
}: {
  permission: {
    requestId: string;
    toolCall: any;
    options: Array<{
      kind: string;
      name: string;
      optionId: string;
    }>;
  };
  onResponse: (requestId: string, optionId: string) => void;
}) {
  const { theme } = useUnistyles();

  // Determine permission type and content based on toolCall
  const getPermissionInfo = () => {
    const rawInput = permission.toolCall?.rawInput || {};
    const toolCallId = permission.toolCall?.toolCallId || "";

    console.log("[PermissionCard] Tool call details:", {
      toolCallId,
      rawInputKeys: Object.keys(rawInput),
      rawInput,
    });

    // Check if this is a plan (ExitPlanMode)
    if (rawInput.plan) {
      return {
        title: "Plan Ready for Review",
        content: rawInput.plan,
        type: "plan" as const,
      };
    }

    // Check if this is a file operation (Write, Edit, etc.)
    if (rawInput.file_path) {
      const operation = toolCallId.includes("Write") ? "Create" : "Edit";
      const fileContent = rawInput.content || rawInput.new_string || "";
      const preview =
        fileContent.length > 500
          ? fileContent.slice(0, 500) + "\n\n... (truncated)"
          : fileContent;

      return {
        title: `${operation} File Permission`,
        content: `File: ${rawInput.file_path}\n\n${preview || "(empty file)"}`,
        type: "file" as const,
      };
    }

    // Check if this is a command (Bash)
    if (rawInput.command) {
      return {
        title: "Run Command Permission",
        content: `Command: ${rawInput.command}\n\nDescription: ${
          rawInput.description || "No description"
        }`,
        type: "command" as const,
      };
    }

    // Fallback - show whatever is in rawInput
    return {
      title: "Permission Required",
      content: JSON.stringify(rawInput, null, 2),
      type: "unknown" as const,
    };
  };

  const permissionInfo = getPermissionInfo();

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
        {permissionInfo.title}
      </Text>

      {permissionInfo.content && (
        <View
          style={[
            permissionStyles.planContainer,
            { backgroundColor: theme.colors.background },
          ]}
        >
          <Text
            style={[
              permissionStyles.planText,
              { color: theme.colors.foreground },
            ]}
          >
            {permissionInfo.content}
          </Text>
        </View>
      )}

      <Text
        style={[
          permissionStyles.question,
          { color: theme.colors.mutedForeground },
        ]}
      >
        How would you like to proceed?
      </Text>

      <View style={permissionStyles.optionsContainer}>
        {permission.options.map((option) => (
          <Pressable
            key={option.optionId}
            style={[
              permissionStyles.optionButton,
              {
                backgroundColor: option.kind.includes("reject")
                  ? theme.colors.destructive
                  : theme.colors.primary,
              },
            ]}
            onPress={() => onResponse(permission.requestId, option.optionId)}
          >
            <Text
              style={[
                permissionStyles.optionText,
                { color: theme.colors.primaryForeground },
              ]}
            >
              {option.name}
            </Text>
          </Pressable>
        ))}
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
  },
  title: {
    fontSize: 16,
    fontWeight: "600",
    marginBottom: theme.spacing[3],
  },
  planContainer: {
    padding: theme.spacing[3],
    borderRadius: theme.spacing[1],
    marginBottom: theme.spacing[3],
  },
  planText: {
    fontSize: 14,
    lineHeight: 20,
  },
  question: {
    fontSize: 14,
    marginBottom: theme.spacing[3],
  },
  optionsContainer: {
    gap: theme.spacing[2],
  },
  optionButton: {
    padding: theme.spacing[3],
    borderRadius: theme.spacing[1],
    alignItems: "center",
  },
  optionText: {
    fontSize: 14,
    fontWeight: "600",
  },
}));
