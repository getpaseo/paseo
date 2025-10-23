import { View, ScrollView } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { forwardRef, useRef, useState } from "react";
import { BottomSheetModal } from "@gorhom/bottom-sheet";
import {
  UserMessage,
  AssistantMessage,
  ActivityLog,
  ToolCall,
} from "@/components/message";
import { ToolCallBottomSheet } from "./tool-call-bottom-sheet";
import type { MessageEntry } from "@/contexts/session-context";
import type { SelectedToolCall } from "@/types/shared";

interface OrchestratorMessagesViewProps {
  messages: MessageEntry[];
  currentAssistantMessage: string;
  onArtifactClick: (artifactId: string) => void;
}

export const OrchestratorMessagesView = forwardRef<ScrollView, OrchestratorMessagesViewProps>(
  function OrchestratorMessagesView({ messages, currentAssistantMessage, onArtifactClick }, ref) {
    const { theme } = useUnistyles();
    const bottomSheetRef = useRef<BottomSheetModal | null>(null);
    const [selectedToolCall, setSelectedToolCall] = useState<SelectedToolCall | null>(null);

    function handleOpenToolCallDetails(toolCall: {
      toolName: string;
      status: 'executing' | 'completed' | 'failed';
      args: any;
      result?: any;
      error?: any;
    }) {
      // Wrap orchestrator tool call in payload structure
      setSelectedToolCall({
        payload: {
          source: 'orchestrator',
          data: {
            toolCallId: `orchestrator_${Date.now()}`, // Generate a simple ID
            toolName: toolCall.toolName,
            arguments: toolCall.args,
            result: toolCall.result,
            error: toolCall.error,
            status: toolCall.status,
          },
        },
      });
      bottomSheetRef.current?.present();
    }

    return (
      <>
        <ScrollView
          ref={ref}
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
        {messages.map((msg) => {
          if (msg.type === "user") {
            return (
              <UserMessage
                key={msg.id}
                message={msg.message}
                timestamp={msg.timestamp}
              />
            );
          }

          if (msg.type === "assistant") {
            return (
              <AssistantMessage
                key={msg.id}
                message={msg.message}
                timestamp={msg.timestamp}
              />
            );
          }

          if (msg.type === "activity") {
            return (
              <ActivityLog
                key={msg.id}
                type={msg.activityType}
                message={msg.message}
                timestamp={msg.timestamp}
                metadata={msg.metadata}
                onArtifactClick={onArtifactClick}
              />
            );
          }

          if (msg.type === "artifact") {
            return (
              <ActivityLog
                key={msg.id}
                type="artifact"
                message=""
                timestamp={msg.timestamp}
                artifactId={msg.artifactId}
                artifactType={msg.artifactType}
                title={msg.title}
                onArtifactClick={onArtifactClick}
              />
            );
          }

          if (msg.type === "tool_call") {
            return (
              <ToolCall
                key={msg.id}
                toolName={msg.toolName}
                args={msg.args}
                result={msg.result}
                error={msg.error}
                status={msg.status}
                onOpenDetails={() => handleOpenToolCallDetails({
                  toolName: msg.toolName,
                  status: msg.status,
                  args: msg.args,
                  result: msg.result,
                  error: msg.error,
                })}
              />
            );
          }

          return null;
        })}

        {/* Streaming assistant message */}
        {currentAssistantMessage && (
          <AssistantMessage
            message={currentAssistantMessage}
            timestamp={Date.now()}
            isStreaming={true}
          />
        )}
      </ScrollView>

      <ToolCallBottomSheet
        bottomSheetRef={bottomSheetRef}
        selectedToolCall={selectedToolCall}
      />
    </>
    );
  }
);

const styles = StyleSheet.create((theme) => ({
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[6],
  },
}));
