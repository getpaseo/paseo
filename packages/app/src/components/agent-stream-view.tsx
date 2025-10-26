import { useEffect, useRef, useState } from "react";
import { View, Text, ScrollView, Pressable } from "react-native";
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
} from "./message";
import { ToolCallBottomSheet } from "./tool-call-bottom-sheet";
import type { StreamItem } from "@/types/stream";
import type {
  SelectedToolCall,
  PendingPermission,
  AgentInfo,
} from "@/types/shared";

export interface AgentStreamViewProps {
  agentId: string;
  agent: AgentInfo;
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
  const scrollViewRef = useRef<ScrollView>(null);
  const bottomSheetRef = useRef<BottomSheetModal | null>(null);
  const insets = useSafeAreaInsets();
  const [selectedToolCall, setSelectedToolCall] =
    useState<SelectedToolCall | null>(null);
  const [isNearBottom, setIsNearBottom] = useState(true);

  // Auto-scroll to bottom when new items arrive, but only if user is already at bottom
  useEffect(() => {
    if (isNearBottom) {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    }
  }, [streamItems, isNearBottom]);

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

  function handleScroll(event: any) {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom =
      contentSize.height - contentOffset.y - layoutMeasurement.height;
    // Consider user "at bottom" if within 10px of the end
    const nearBottom = distanceFromBottom < 10;
    console.log('[AgentStreamView] Scroll:', { 
      contentHeight: contentSize.height, 
      scrollY: contentOffset.y, 
      layoutHeight: layoutMeasurement.height,
      distanceFromBottom, 
      nearBottom,
      currentIsNearBottom: isNearBottom
    });
    setIsNearBottom(nearBottom);
  }

  function scrollToBottom() {
    scrollViewRef.current?.scrollToEnd({ animated: true });
  }

  return (
    <View style={stylesheet.container}>
      {/* Content list */}
      <ScrollView
        ref={scrollViewRef}
        style={stylesheet.scrollView}
        contentContainerStyle={{
          paddingTop: 24,
          paddingBottom: Math.max(insets.bottom, 32),
        }}
        onScroll={handleScroll}
        scrollEventThrottle={16}
      >
        {streamItems.length === 0 ? (
          <View style={stylesheet.emptyState}>
            <Text style={stylesheet.emptyStateText}>
              Start chatting with this agent...
            </Text>
          </View>
        ) : (
          streamItems.map((item) => {
            switch (item.kind) {
              case "user_message":
                return (
                  <UserMessage
                    key={item.id}
                    message={item.text}
                    timestamp={item.timestamp.getTime()}
                  />
                );

              case "assistant_message":
                return (
                  <AssistantMessage
                    key={item.id}
                    message={item.text}
                    timestamp={item.timestamp.getTime()}
                  />
                );

              case "thought":
                return (
                  <ActivityLog
                    key={item.id}
                    type="info"
                    message={item.text}
                    timestamp={item.timestamp.getTime()}
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
                      key={item.id}
                      toolName={data.title ?? "Unknown Tool"}
                      kind={data.kind}
                      args={data.rawInput}
                      result={data.rawOutput}
                      status={toolStatus}
                      onOpenDetails={() =>
                        handleOpenToolCallDetails({ payload })
                      }
                    />
                  );
                } else {
                  // Orchestrator tool call
                  const data = payload.data;
                  return (
                    <ToolCall
                      key={item.id}
                      toolName={data.toolName}
                      args={data.arguments}
                      result={data.result}
                      status={data.status}
                      onOpenDetails={() =>
                        handleOpenToolCallDetails({ payload })
                      }
                    />
                  );
                }
              }

              case "plan":
                // TODO: Render plan component
                return null;

              case "activity_log":
              case "artifact":
                // These are orchestrator-only, skip for now
                return null;

              default:
                return null;
            }
          })
        )}

        {/* Render pending permissions for this agent */}
        {Array.from(pendingPermissions.values())
          .filter((perm) => perm.agentId === agentId)
          .map((permission) => (
            <PermissionRequestCard
              key={permission.requestId}
              permission={permission}
              onResponse={onPermissionResponse}
            />
          ))}
      </ScrollView>

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
            <ChevronDown size={24} color={stylesheet.scrollToBottomIcon.color} />
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
  scrollView: {
    flex: 1,
    paddingHorizontal: theme.spacing[2],
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[12],
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
