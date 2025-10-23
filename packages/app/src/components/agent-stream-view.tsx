import { useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { BottomSheetModal } from '@gorhom/bottom-sheet';
import type { AgentStatus } from '@server/server/acp/types';
import { AssistantMessage, UserMessage, ActivityLog, ToolCall } from './message';
import { ToolCallBottomSheet } from './tool-call-bottom-sheet';
import type { StreamItem } from '@/types/stream';

export interface AgentStreamViewProps {
  agentId: string;
  agent: {
    id: string;
    status: AgentStatus;
    createdAt: Date;
    type: 'claude';
  };
  streamItems: StreamItem[];
  pendingPermissions: Map<
    string,
    {
      agentId: string;
      requestId: string;
      sessionId: string;
      toolCall: any;
      options: Array<{
        kind: string;
        name: string;
        optionId: string;
      }>;
    }
  >;
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
  const bottomSheetRef = useRef<BottomSheetModal>(null);
  const insets = useSafeAreaInsets();
  const [selectedToolCall, setSelectedToolCall] = useState<{
    toolName: string;
    status: 'executing' | 'completed' | 'failed';
    args: any;
    result?: any;
    error?: any;
  } | null>(null);

  // Auto-scroll to bottom when new items arrive
  useEffect(() => {
    scrollViewRef.current?.scrollToEnd({ animated: true });
  }, [streamItems]);

  function handleOpenToolCallDetails(toolCall: {
    toolName: string;
    status: 'executing' | 'completed' | 'failed';
    args: any;
    result?: any;
    error?: any;
  }) {
    setSelectedToolCall(toolCall);
    bottomSheetRef.current?.present();
  }

  return (
    <View style={stylesheet.container}>
      {/* Content list */}
      <ScrollView
        ref={scrollViewRef}
        style={stylesheet.scrollView}
        contentContainerStyle={{ paddingTop: 24, paddingBottom: Math.max(insets.bottom, 32) }}
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
              case 'user_message':
                return (
                  <UserMessage
                    key={item.id}
                    message={item.text}
                    timestamp={item.timestamp.getTime()}
                  />
                );

              case 'assistant_message':
                return (
                  <AssistantMessage
                    key={item.id}
                    message={item.text}
                    timestamp={item.timestamp.getTime()}
                  />
                );

              case 'thought':
                return (
                  <ActivityLog
                    key={item.id}
                    type="info"
                    message={item.text}
                    timestamp={item.timestamp.getTime()}
                  />
                );

              case 'tool_call': {
                // Map status: pending/in_progress -> executing, completed -> completed, failed -> failed
                const toolStatus = item.status === 'pending' || item.status === 'in_progress'
                  ? 'executing' as const
                  : item.status === 'completed'
                  ? 'completed' as const
                  : 'failed' as const;

                return (
                  <ToolCall
                    key={item.id}
                    toolName={item.title}
                    args={item.rawInput}
                    result={item.rawOutput}
                    status={toolStatus}
                    onOpenDetails={() => handleOpenToolCallDetails({
                      toolName: item.title,
                      status: toolStatus,
                      args: item.rawInput,
                      result: item.rawOutput,
                    })}
                  />
                );
              }

              case 'plan':
                // TODO: Render plan component
                return null;

              case 'activity_log':
              case 'artifact':
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

      <ToolCallBottomSheet
        bottomSheetRef={bottomSheetRef}
        toolName={selectedToolCall?.toolName}
        status={selectedToolCall?.status}
        args={selectedToolCall?.args}
        result={selectedToolCall?.result}
        error={selectedToolCall?.error}
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
    const toolCallId = permission.toolCall?.toolCallId || '';

    console.log('[PermissionCard] Tool call details:', {
      toolCallId,
      rawInputKeys: Object.keys(rawInput),
      rawInput,
    });

    // Check if this is a plan (ExitPlanMode)
    if (rawInput.plan) {
      return {
        title: 'Plan Ready for Review',
        content: rawInput.plan,
        type: 'plan' as const,
      };
    }

    // Check if this is a file operation (Write, Edit, etc.)
    if (rawInput.file_path) {
      const operation = toolCallId.includes('Write') ? 'Create' : 'Edit';
      const fileContent = rawInput.content || rawInput.new_string || '';
      const preview = fileContent.length > 500
        ? fileContent.slice(0, 500) + '\n\n... (truncated)'
        : fileContent;

      return {
        title: `${operation} File Permission`,
        content: `File: ${rawInput.file_path}\n\n${preview || '(empty file)'}`,
        type: 'file' as const,
      };
    }

    // Check if this is a command (Bash)
    if (rawInput.command) {
      return {
        title: 'Run Command Permission',
        content: `Command: ${rawInput.command}\n\nDescription: ${rawInput.description || 'No description'}`,
        type: 'command' as const,
      };
    }

    // Fallback - show whatever is in rawInput
    return {
      title: 'Permission Required',
      content: JSON.stringify(rawInput, null, 2),
      type: 'unknown' as const,
    };
  };

  const permissionInfo = getPermissionInfo();

  return (
    <View
      style={[
        permissionStyles.container,
        { backgroundColor: theme.colors.secondary, borderColor: theme.colors.border },
      ]}
    >
      <Text style={[permissionStyles.title, { color: theme.colors.foreground }]}>
        {permissionInfo.title}
      </Text>

      {permissionInfo.content && (
        <View style={[permissionStyles.planContainer, { backgroundColor: theme.colors.background }]}>
          <Text style={[permissionStyles.planText, { color: theme.colors.foreground }]}>
            {permissionInfo.content}
          </Text>
        </View>
      )}

      <Text style={[permissionStyles.question, { color: theme.colors.mutedForeground }]}>
        How would you like to proceed?
      </Text>

      <View style={permissionStyles.optionsContainer}>
        {permission.options.map((option) => (
          <Pressable
            key={option.optionId}
            style={[
              permissionStyles.optionButton,
              {
                backgroundColor: option.kind.includes('reject')
                  ? theme.colors.destructive
                  : theme.colors.primary,
              },
            ]}
            onPress={() => onResponse(permission.requestId, option.optionId)}
          >
            <Text style={[permissionStyles.optionText, { color: theme.colors.primaryForeground }]}>
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
    paddingHorizontal: theme.spacing[4],
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
